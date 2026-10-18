import { type DbConfig, type ErrorCode, EyesError } from "@eyes/core";
import postgres from "postgres";

export type RpcArgs = Record<string, unknown>;
export type Rpc = <T>(fn: string, args: RpcArgs) => Promise<T[]>;

const DB_ERROR = /^eyes:(\w+)\s*(.*)$/s;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Postgres text and jsonb can't hold NUL or unpaired surrogates: drop NUL, turn lone surrogates into U+FFFD. */
export function pgSafe<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\0", "").replace(LONE_SURROGATE, "\ufffd") as T;
  if (Array.isArray(value)) return value.map(pgSafe) as T;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [pgSafe(k), pgSafe(v)])) as T;
  }
  return value;
}

export function createRpc(db: DbConfig): Rpc {
  const call = db.kind === "postgres" ? postgresRpc(db.url) : insforgeRpc(db.base_url, db.api_key);
  return async <T>(fn: string, args: RpcArgs) => {
    try {
      return (await call(fn, pgSafe(args))) as T[];
    } catch (err) {
      const m = err instanceof Error ? DB_ERROR.exec(err.message) : null;
      if (!m) throw err;
      throw new EyesError(m[1] as ErrorCode, m[2] ? JSON.parse(m[2]) : {});
    }
  };
}

function postgresRpc(url: string) {
  const sql = postgres(url, { onnotice: () => {} });
  return async (fn: string, args: RpcArgs): Promise<unknown[]> => {
    const named = Object.keys(args).map((key, i) => `${key} => $${i + 1}`);
    const rows = await sql.unsafe(
      `select to_jsonb(r) as r from ${fn}(${named.join(", ")}) r`,
      Object.values(args) as postgres.ParameterOrJSON<never>[],
    );
    return rows.map((row) => row.r);
  };
}

function insforgeRpc(baseUrl: string, apiKey: string) {
  return async (fn: string, args: RpcArgs): Promise<unknown[]> => {
    const res = await fetch(`${baseUrl}/api/database/rpc/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.message ?? `InsForge rpc ${fn} failed with HTTP ${res.status}`);
    return body;
  };
}
