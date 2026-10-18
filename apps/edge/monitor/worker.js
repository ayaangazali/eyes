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
    await check(env);
  },
};

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
