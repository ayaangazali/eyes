// Uptime alert for Eyes. Runs outside the Eyes server so it still reports when the server moves or dies.
// Each minute: GET HEALTH_URL. Two failures in a row -> "down" iMessage. Next success -> "back up" iMessage.
// Silent otherwise. State is one KV key.
// ponytail: one URL, one channel (iMessage), read-modify-write on one key. Runs never overlap:
// probe (10 s) + send (25 s) fit inside the 60 s tick. Add a second channel or URL when one hurts.

const FAILS_BEFORE_DOWN = 2;
const PROBE_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 25_000;
const UA = "eyes-monitor/1.0";

export default {
  async scheduled(_event, env) {
    // Neither background trigger may stop the uptime check or its retry.
    const [health] = await Promise.allSettled([
      check(env),
      release(env).catch((err) => console.log(`release trigger: ${err.message}`)),
      expire(env).catch((err) => console.log(`expiry trigger: ${err.message}`)),
      abuse(env).catch((err) => console.log(`abuse alert: ${err.message}`)),
    ]);
    if (health.status === "rejected") throw health.reason;
  },
};

// Abuse spikes (ADR-052, OWASP API2:2023): count recent rows in the events table per signal.
// A signal at or over its limit within WINDOW sends one alert and stays quiet until it drops under the limit.
// ponytail: fixed limits, one shared window. Move them to env when a limit needs tuning per deploy.
const ABUSE_WINDOW_MS = 10 * 60_000;
const ABUSES = [
  {
    key: "rate_limited",
    label: "429 responses",
    limit: 50,
    filter: "kind=eq.call&data->>error=eq.rate_limited",
  },
  {
    key: "failed_logins",
    label: "failed ops logins",
    limit: 10,
    filter: "kind=eq.auth&summary=in.(login fail,login locked)",
  },
  { key: "disputes", label: "answer disputes", limit: 5, filter: "kind=eq.call&summary=eq.disputeAnswer ok" },
  { key: "bans", label: "worker bans", limit: 3, filter: "kind=eq.ops&data->>action=eq.confirm_fraud" },
];

async function abuse(env) {
  if (!env.INSFORGE_BASE_URL || !env.INSFORGE_API_KEY) return;
  const since = encodeURIComponent(new Date(Date.now() - ABUSE_WINDOW_MS).toISOString());
  const prev = (await env.EYES_MONITOR.get("abuse", "json")) ?? {};
  const next = {};
  for (const a of ABUSES) {
    // limit=N means N rows already proves the spike, so the read stays small.
    const res = await fetch(
      `${env.INSFORGE_BASE_URL.replace(/\/+$/, "")}/api/database/records/events?select=id&at=gte.${since}&${a.filter}&limit=${a.limit}`,
      {
        headers: { Authorization: `Bearer ${env.INSFORGE_API_KEY}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`InsForge HTTP ${res.status}`);
    next[a.key] = (await res.json()).length >= a.limit;
    if (next[a.key] && !prev[a.key]) {
      await send(
        env,
        `Eyes abuse spike: ${a.label}`,
        `${a.limit} or more ${a.label} in the last ${ABUSE_WINDOW_MS / 60_000} minutes. Check the ops events tab.`,
      );
    }
  }
  await env.EYES_MONITOR.put("abuse", JSON.stringify(next));
}

async function expire(env) {
  if (!env.INSFORGE_BASE_URL || !env.INSFORGE_API_KEY) return;
  const res = await fetch(
    `${env.INSFORGE_BASE_URL.replace(/\/+$/, "")}/api/database/rpc/eyes_expire_overdue`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.INSFORGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_now: new Date().toISOString() }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Ad hoc iPhone releases (T6.31): GitHub's scheduler on i098/eyes-ios-release is unreliable, so each minute
// count unreleased worker iPhones and, when some wait and no release run is active, start one.
// At most one dispatch per RELEASE_EVERY_MS so a failing build is not restarted every minute.
const RELEASE_REPO = "i098/eyes-ios-release";
const RELEASE_EVERY_MS = 10 * 60_000;

async function release(env) {
  if (!env.RELEASE_DISPATCH_TOKEN) return;
  const db = await fetch(
    `${env.INSFORGE_BASE_URL.replace(/\/+$/, "")}/api/database/records/worker_devices?select=udid&released_at=is.null`,
    {
      headers: { Authorization: `Bearer ${env.INSFORGE_API_KEY}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    },
  );
  if (!db.ok) throw new Error(`InsForge HTTP ${db.status}`);
  const pending = (await db.json()).length;
  if (pending === 0) return;
  const last = (await env.EYES_MONITOR.get("release", "json"))?.at ?? 0;
  if (Date.now() - last < RELEASE_EVERY_MS) return;
  const gh = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${RELEASE_REPO}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.RELEASE_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  const runs = await gh("/actions/runs?per_page=10");
  if (!runs.ok) throw new Error(`GitHub runs HTTP ${runs.status}`);
  if ((await runs.json()).workflow_runs.some((r) => r.status !== "completed")) return;
  const res = await gh("/dispatches", {
    method: "POST",
    body: JSON.stringify({ event_type: "device-registered" }),
  });
  if (!res.ok) throw new Error(`GitHub dispatch HTTP ${res.status}`);
  await env.EYES_MONITOR.put("release", JSON.stringify({ at: Date.now() }));
  console.log(`release started: ${pending} iPhone(s) waiting`);
}

async function check(env) {
  const prev = (await env.EYES_MONITOR.get("state", "json")) ?? { fails: 0, down: false, since: 0 };
  const now = Date.now();
  const reason = await probe(env.HEALTH_URL);

  if (reason === null) {
    if (prev.down) {
      const mins = Math.max(1, Math.round((now - prev.since) / 60_000));
      await send(
        env,
        `Eyes API is back up (down ${mins} min)`,
        `${env.HEALTH_URL} is healthy again at ${new Date(now).toISOString()}.`,
      );
    }
    await env.EYES_MONITOR.put("state", JSON.stringify({ fails: 0, down: false, since: 0 }));
    return;
  }

  const fails = prev.fails + 1;
  const since = prev.fails === 0 ? now : prev.since;
  const down = prev.down || fails >= FAILS_BEFORE_DOWN;
  if (down && !prev.down) {
    await send(
      env,
      `Eyes API is down: ${reason}`,
      `${env.HEALTH_URL} failed ${fails} checks in a row, first at ${new Date(since).toISOString()}. Last reason: ${reason}.`,
    );
  }
  await env.EYES_MONITOR.put("state", JSON.stringify({ fails, down, since, reason }));
}

// null when healthy, otherwise the reason in words.
async function probe(url) {
  let res;
  try {
    res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (err) {
    return err.name === "TimeoutError" ? "no answer in 10 s" : `request failed (${err.message})`;
  }
  if (res.status !== 200) return `HTTP ${res.status}`;
  const body = await res.json().catch(() => null);
  if (!body) return "body is not JSON";
  if (body.ok !== true) return "ok is not true";
  const providers = Object.entries(body.providers ?? {});
  const notLive = providers
    .filter(([, state]) => state !== "live")
    .map(([name, state]) => `${name} ${state}`);
  if (providers.length === 0 || notLive.length > 0) {
    return `providers not live: ${notLive.join(", ") || "none reported"}`;
  }
  if (body.db !== "insforge") return `db is ${body.db ?? "missing"}`;
  return null;
}

// Throws on failure so the tick retries next minute (state is not written).
async function send(env, subject, text) {
  const api = "https://inkbox.ai/api/v1";
  const headers = { "X-API-Key": env.INKBOX_API_KEY };
  const ident = await fetch(`${api}/identities/${encodeURIComponent(env.INKBOX_AGENT_HANDLE)}`, {
    headers: { ...headers, accept: "application/json" },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const id = (await ident.json().catch(() => ({})))?.id;
  if (!ident.ok || !id) throw new Error(`alert not sent: Inkbox identity lookup HTTP ${ident.status}`);
  const res = await fetch(`${api}/imessage/messages?agent_identity_id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      Prefer: "idempotency-replay",
    },
    body: JSON.stringify({ to: env.ALERT_PHONE, text: `${env.SUBJECT_PREFIX}${subject}\n${text}` }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  const msg = body?.message ?? {};
  if (!res.ok || ["error", "declined"].includes(msg.status)) {
    throw new Error(`alert not sent: Inkbox HTTP ${res.status} ${msg.errorCode ?? msg.status ?? ""}`.trim());
  }
  // A 2xx with no message id (a non-JSON body included) is not a sent alert, so the tick retries.
  if (!msg.id) throw new Error(`alert not sent: Inkbox HTTP ${res.status} no message id`);
  console.log(`alert sent: "${subject}" id=${msg.id} status=${msg.status}`);
}
