import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream } from "node:stream/web";
import { EyesError, HTTP_ROUTES } from "@eyes/core";

const MB = 1024 * 1024;
const CAPTURE_LIMIT = 21 * MB;
const DEFAULT_LIMIT = MB;
const READ_DEADLINE_MS = 60_000;
const CAPTURE_PATH = /^\/w\/offers\/[^/]+\/capture$/;
const LOGGED_ROUTES = [
  "/",
  "/agents.md",
  "/robots.txt",
  "/status",
  "/topup/done",
  "/topup/cancel",
  "/w/connect/done",
  "/w/location",
  "/v1/worker/location",
  "/s/:id",
  ...Object.values(HTTP_ROUTES).map((route) => route.slice(route.indexOf("/"))),
].map((path) => ({
  pattern: new RegExp(`^${path.replaceAll(".", "\\.").replace(/:\w+/g, "[^/]+")}$`),
  logged: path.replace(/:(\w+)/g, "<$1>"),
}));

type Fetch = (request: Request) => Promise<Response>;

/**
 * With EDGE_SECRET set the server sits behind the edge Worker (apps/edge/api), possibly via another
 * proxy that appends to x-forwarded-for or rewrites x-forwarded-host. Only a request carrying the
 * secret may name the client IP and original host; one reaching the origin directly cannot spoof
 * them (its cf-connecting-ip and x-forwarded-host are dropped, x-forwarded-for is left as is).
 */
function trustEdge(headers: Headers, secret: string | undefined) {
  const given = headers.get("x-eyes-edge-secret") ?? "";
  const ip = headers.get("x-eyes-client-ip")?.trim();
  const host = headers.get("x-eyes-host");
  for (const name of ["x-eyes-edge-secret", "x-eyes-client-ip", "x-eyes-host"]) headers.delete(name);
  if (!secret) return;
  headers.delete("cf-connecting-ip");
  const sha = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(sha(given), sha(secret))) return void headers.delete("x-forwarded-host");
  if (ip) headers.set("x-forwarded-for", ip);
  if (host) headers.set("x-forwarded-host", host);
}

function tooLarge(req: IncomingMessage, limit: number): Response {
  req.resume();
  const err = new EyesError(
    "payload_too_large",
    { max_bytes: limit },
    {
      message: `The request body is larger than ${limit} bytes.`,
      fix:
        limit === CAPTURE_LIMIT
          ? "Retake the photo at a lower resolution and submit again."
          : "Send a smaller request. No Eyes call needs a body over 1 MB.",
    },
  );
  return Response.json(err.toBody(), { status: err.status });
}

const routeOf = (pathname: string) =>
  LOGGED_ROUTES.find((route) => route.pattern.test(pathname))?.logged ?? "<other>";

function badTarget(req: IncomingMessage): Response {
  req.resume();
  const issues = [{ path: "", message: "The request target is not a valid URL path." }];
  const err = new EyesError("invalid_input", { issues }, { fix: "Send a plain path such as /v1/balance." });
  return Response.json(err.toBody(), { status: 400 });
}

async function* limited(req: IncomingMessage, limit: number, state: { overflow: boolean }) {
  let seen = 0;
  const deadline = setTimeout(() => req.destroy(), READ_DEADLINE_MS);
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      seen += chunk.length;
      if (seen > limit) {
        state.overflow = true;
        throw new Error("request body too large");
      }
      yield new Uint8Array(chunk);
    }
  } finally {
    clearTimeout(deadline);
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage, limit: number, state: { overflow: boolean }) {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of limited(req, limit, state)) chunks.push(chunk);
  } catch (err) {
    if (state.overflow) return null;
    throw err;
  }
  return Buffer.concat(chunks);
}

async function respond(
  req: IncomingMessage,
  url: URL,
  fetch: Fetch,
  signal: AbortSignal,
  edgeSecret: string | undefined,
): Promise<Response> {
  const type = (req.headers["content-type"] ?? "").toLowerCase();
  const multipart = type.startsWith("multipart/form-data") && !type.includes("application/json");
  const limit =
    req.method === "POST" && multipart && CAPTURE_PATH.test(url.pathname) ? CAPTURE_LIMIT : DEFAULT_LIMIT;
  if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(req, limit);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  trustEdge(headers, edgeSecret);
  if (!headers.get("x-forwarded-for")?.trim()) headers.set("x-forwarded-for", req.socket.remoteAddress ?? "");
  const state = { overflow: false };
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const mcp = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
  let body: Uint8Array | ReadableStream<Uint8Array> | undefined;
  if (!mcp && !hasBody) headers.delete("content-type");
  if (!mcp && hasBody && type.includes("application/json")) {
    const bytes = await readJsonBody(req, limit, state);
    if (!bytes) return tooLarge(req, limit);
    const text = bytes.toString("utf8");
    if (text.trim() === "") headers.delete("content-type");
    else if (!isJson(text)) {
      const issues = [{ path: "", message: "Request body is not valid JSON." }];
      return Response.json(new EyesError("invalid_input", { issues }).toBody(), { status: 400 });
    } else body = bytes;
  } else if (hasBody) body = ReadableStream.from(limited(req, limit, state));
  const request = new Request(url, {
    method: req.method,
    headers,
    body,
    duplex: "half",
    signal,
  } as RequestInit);
  const response = await fetch(request).catch((err) => {
    if (state.overflow) return undefined;
    throw err;
  });
  return state.overflow || !response ? tooLarge(req, limit) : response;
}

export function toNodeListener(fetch: Fetch, edgeSecret?: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const abort = new AbortController();
    let path = "<unparsable>";
    res.on("close", () => abort.abort());
    res.on("finish", () => console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      const parsed = URL.parse(req.url ?? "/", "http://localhost");
      const url = parsed && !parsed.username && !parsed.password ? parsed : null;
      if (url) path = routeOf(url.pathname);
      const response = url
        ? await respond(
            req,
            new URL(`http://localhost${url.pathname}${url.search}`),
            fetch,
            abort.signal,
            edgeSecret,
          )
        : badTarget(req);
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("set-cookie", cookies);
      if (!response.body) return void res.end();
      await pipeline(Readable.fromWeb(response.body as ReadableStream), res).catch(() => undefined);
    } catch (err) {
      console.error(`request failed: ${err instanceof Error ? err.name : "unknown error"}`);
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(new EyesError("internal_error").toBody()));
    }
  };
}
