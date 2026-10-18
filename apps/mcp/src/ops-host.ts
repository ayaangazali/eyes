import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

export type OpsSite = { base: string; origin: string };

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LEGACY = /^\/ops(?=\/|$)/;
const HOP = "x-eyes-ops-hop";

/** The dashboard's own origin: EYES_OPS_URL, else the API origin with `api.` swapped for `internal.`. */
export function opsOriginFor(publicApiUrl: string, override?: string) {
  if (override) return new URL(override).origin;
  const url = new URL(publicApiUrl);
  if (!url.hostname.startsWith("api.")) return null;
  url.hostname = `internal.${url.hostname.slice(4)}`;
  return url.origin;
}

/**
 * The ops dashboard has its own host (internal.eyes.pictures): `/x` there is served by the `/ops/x`
 * routes, and nothing else of the API answers there. Any other host gets a 301 from `/ops*` to the
 * ops host, except loopback, which keeps `/ops` for tests and local runs. With no ops origin (an API
 * URL without `api.`), `/ops` stays on the API host as before.
 */
export function opsHost(
  apiOrigin: string,
  opsOrigin: string | null,
  fetch: (req: Request) => Promise<Response>,
) {
  // Marks the internal re-dispatch; random per process, so a client cannot send it.
  const token = randomUUID();
  const host = opsOrigin && new URL(opsOrigin).host;
  const viaOpsHost = (c: Context) => c.req.header(HOP) === token;
  const route: MiddlewareHandler = async (c, next) => {
    if (!opsOrigin || viaOpsHost(c)) return next();
    const url = new URL(c.req.url);
    // The edge Worker sets x-forwarded-host; http.ts rewrites the URL to localhost and keeps Host.
    const seen = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
    const legacy = LEGACY.test(url.pathname);
    const bare = `${url.pathname.replace(LEGACY, "") || "/"}${url.search}`;
    if (seen === host) {
      if (legacy) return c.redirect(bare, 301);
      // Shared static files (the header font) keep their path.
      if (!url.pathname.startsWith("/fonts/"))
        url.pathname = url.pathname === "/" ? "/ops" : `/ops${url.pathname}`;
      const req = new Request(url, c.req.raw);
      req.headers.set(HOP, token);
      return fetch(req);
    }
    if (legacy && !LOOPBACK.test(seen)) return c.redirect(`${opsOrigin}${bare}`, 301);
    return next();
  };
  const site = (c: Context): OpsSite =>
    opsOrigin && viaOpsHost(c) ? { base: "", origin: opsOrigin } : { base: "/ops", origin: apiOrigin };
  return { route, site };
}
