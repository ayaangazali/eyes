import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream } from "node:stream/web";
import { EyesError } from "@eyes/core";

const MB = 1024 * 1024;
const CAPTURE_LIMIT = 21 * MB;
const DEFAULT_LIMIT = MB;
const CAPTURE_PATH = /^\/w\/offers\/[^/]+\/capture$/;
const TOKEN_PATH = /^(\/w\/offers|\/w\/connect|\/topup)\/[^/?]+/;

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

async function respond(req: IncomingMessage, fetch: Fetch, signal: AbortSignal): Promise<Response> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const limit = req.method === "POST" && CAPTURE_PATH.test(url.pathname) ? CAPTURE_LIMIT : DEFAULT_LIMIT;
  if (Number(req.headers["content-length"] ?? 0) > limit) return tooLarge(req, limit);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const state = { overflow: false };
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? ReadableStream.from(limited(req, limit, state)) : undefined,
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
    res.on("close", () => abort.abort());
    res.on("finish", () => {
      const path = (req.url ?? "/").replace(TOKEN_PATH, "$1/<token>");
      console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      const response = await respond(req, fetch, abort.signal);
      res.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("set-cookie", cookies);
      if (!response.body) return void res.end();
      await pipeline(Readable.fromWeb(response.body as ReadableStream), res).catch(() => undefined);
    } catch (err) {
      console.error(err);
      if (res.headersSent) return void res.destroy();
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(new EyesError("internal_error").toBody()));
    }
  };
}
