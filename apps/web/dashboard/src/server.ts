import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { DbConfig } from "@eyes/core";
import { createRpc, type Rpc } from "@eyes/db";

export const PAGE = readFileSync(new URL("./index.html", import.meta.url), "utf8");
export const UI_CSS = ["tokens.css", "components.css"]
  .map((file) => readFileSync(new URL(`../../../../packages/ui/${file}`, import.meta.url), "utf8"))
  .join("\n");
export const OPS_PAGE = readFileSync(new URL("./ops.html", import.meta.url), "utf8").replace(
  "/* @eyes/ui */",
  () => UI_CSS,
);
export {
  buildSeries,
  type ClickHouseSink,
  clickHouseConfig,
  createClickHouseSink,
  fallbackRows,
  mirrorTriggerEvents,
  readClickHouseSeries,
  type Series,
} from "./clickhouse.ts";
export {
  captureConsole,
  createEventLog,
  type EventLog,
  type Feed,
  type LoggedEvent,
  type OpsEvent,
  redact,
  summarize,
} from "./ops.ts";

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const FEED_LIMIT = 50;

export async function readFeed(rpc: Rpc, limit = FEED_LIMIT) {
  const [feed] = await rpc<Record<string, unknown>>("eyes_dashboard_feed", { p_limit: limit });
  return feed;
}

export function createDashboardServer(rpc: Rpc) {
  return createServer(async (req, res) => {
    if (!LOOPBACK_HOST.test(req.headers.host ?? "")) {
      res.writeHead(403).end();
      return;
    }
    const path = req.method === "GET" ? req.url?.split("?")[0] : null;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
      return;
    }
    if (path === "/feed") {
      try {
        const feed = await readFeed(rpc);
        res
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify(feed));
      } catch (err) {
        console.error("feed failed:", err instanceof Error ? err.message : err);
        res.writeHead(502, { "content-type": "application/json" }).end('{"error":"feed_unavailable"}');
      }
      return;
    }
    res.writeHead(404).end();
  });
}

export function dbFromEnv(env: Record<string, string | undefined>): DbConfig {
  const { DATABASE_URL, INSFORGE_BASE_URL, INSFORGE_API_KEY } = env;
  if (DATABASE_URL) return { kind: "postgres", url: DATABASE_URL };
  if (INSFORGE_BASE_URL && INSFORGE_API_KEY)
    return { kind: "insforge", base_url: INSFORGE_BASE_URL, api_key: INSFORGE_API_KEY };
  throw new Error("Set DATABASE_URL, or INSFORGE_BASE_URL and INSFORGE_API_KEY, to read the feed.");
}

export function startFromEnv(
  env: Record<string, string | undefined>,
  log: (line: string) => void = console.log,
) {
  const port = Number(env.PORT ?? "4400");
  return createDashboardServer(createRpc(dbFromEnv(env))).listen(port, "127.0.0.1", () =>
    log(`EYES dashboard on http://127.0.0.1:${port}`),
  );
}

/* v8 ignore start -- process entry: only runs when this file is the main module */
if (import.meta.main) startFromEnv(process.env);
/* v8 ignore stop */
