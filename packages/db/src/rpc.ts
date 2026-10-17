import { type DbConfig, type ErrorCode, EyesError } from "@eyes/core";
import postgres from "postgres";

export type RpcArgs = Record<string, unknown>;
export type Rpc = <T>(fn: string, args: RpcArgs) => Promise<T[]>;

const DB_ERROR = /^eyes:(\w+)\s*(.*)$/s;

export function createRpc(db: DbConfig): Rpc {
  const call = db.kind === "postgres" ? postgresRpc(db.url) : insforgeRpc(db.base_url, db.api_key);
  return async <T>(fn: string, args: RpcArgs) => {
    try {
      return (await call(fn, args)) as T[];
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
