import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream } from "node:stream/web";
import { EyesError } from "@eyes/core";

const MB = 1024 * 1024;
const CAPTURE_LIMIT = 21 * MB;
const DEFAULT_LIMIT = MB;
const CAPTURE_PATH = /^\/w\/offers\/[^/]+\/capture$/;
const TOKEN = /[\w-]{16,}\.[\w-]{16,}/g;

type Fetch = (request: Request) => Promise<Response>;

function tooLarge(req: IncomingMessage, limit: number): Response {
  req.resume();
  const err = new EyesError(
    "invalid_input",
    { max_bytes: limit },
    {
      message: `The request body is larger than ${limit} bytes.`,
      fix:
        limit === CAPTURE_LIMIT
          ? "Retake the photo at a lower resolution and submit again."
          : "Send a smaller request. No Eyes call needs a body over 1 MB.",
    },
  );
  return Response.json(err.toBody(), { status: 413 });
}

function decodeRun(run: string): string {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
}

function redact(pathname: string): string {
  return pathname
    .replace(/(?:%[0-9A-Fa-f]{2})+/g, decodeRun)
    .replace(TOKEN, "<token>")
    .replace(/[^/]*@/g, "<redacted>@");
}

function badTarget(req: IncomingMessage): Response {
  req.resume();
  const issues = [{ path: "", message: "The request target is not a valid URL path." }];
  const err = new EyesError("invalid_input", { issues }, { fix: "Send a plain path such as /v1/balance." });
  return Response.json(err.toBody(), { status: 400 });
}

async function* limited(req: IncomingMessage, limit: number, state: { overflow: boolean }) {
  let seen = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    seen += chunk.length;
    if (seen > limit) {
      state.overflow = true;
      throw new Error("request body too large");
    }
    yield new Uint8Array(chunk);
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

async function respond(req: IncomingMessage, url: URL, fetch: Fetch, signal: AbortSignal): Promise<Response> {
  const type = (req.headers["content-type"] ?? "").toLowerCase();
  const multipart = type.startsWith("multipart/form-data") && !type.includes("application/json");
  const limit =
    req.method === "POST" && multipart && CAPTURE_PATH.test(url.pathname) ? CAPTURE_LIMIT : DEFAULT_LIMIT;
  if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(req, limit);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
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

export function toNodeListener(fetch: Fetch) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const abort = new AbortController();
    let path = "<unparsable>";
    res.on("close", () => abort.abort());
    res.on("finish", () => console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      const parsed = URL.parse(req.url ?? "/", "http://localhost");
      const url = parsed && !parsed.username && !parsed.password ? parsed : null;
      if (url) path = redact(url.pathname);
      const response = url
        ? await respond(req, new URL(`http://localhost${url.pathname}${url.search}`), fetch, abort.signal)
        : badTarget(req);
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("set-cookie", cookies);
      if (!response.body) return void res.end();
      await pipeline(Readable.fromWeb(response.body as ReadableStream), res).catch(() => undefined);
    } catch (err) {
      console.error(`request failed: ${err instanceof Error ? err.name : "unknown error"}`);
      if (res.headersSent) return void res.destroy();
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(new EyesError("internal_error").toBody()));
    }
  };
}
