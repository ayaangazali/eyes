import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type Agent, AppConfig, EyesError, fakeGeo, fakeProviders } from "../packages/core/src/index.ts";
import { createRpc } from "../packages/db/src/index.ts";
import { createEyesService } from "../packages/engine/src/index.ts";
import { createAssessTask } from "../packages/safety/src/index.ts";
import { verifySubmission } from "../packages/verify/src/index.ts";

type Env = Record<string, string | undefined>;
export type Fate = "paid" | "claimed" | "cancelled" | "expired";

const SEED = 20261017;
const WORKER_COUNT = 40;
const POST_WINDOW_S = 45;
const EXPIRING_DEADLINE_MIN = 5;
const DEADLINE_MIN = 30;
const CLAIM_CUTOFF_S = 52;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const BOUNTIES = [2, 3, 3, 3, 4, 5];

const KINDS = {
  is_open: {
    ask: (place: string) => `Is ${place} open right now?`,
    answer: "Open, door unlocked.",
    bool: true,
  },
  line_length: {
    ask: (place: string) => `How long is the line at ${place} right now?`,
    answer: "About 5 people in line.",
    bool: null,
  },
  in_stock: {
    ask: (place: string) => `Is oat milk in stock at ${place} right now?`,
    answer: "Yes, a full shelf.",
    bool: true,
  },
  price_check: {
    ask: (place: string) => `What is the shelf price of a dozen eggs at ${place}?`,
    answer: "$4.99 on the shelf tag.",
    bool: null,
  },
  crowd_level: {
    ask: (place: string) => `How crowded is ${place} right now?`,
    answer: "Busy, about 40 people.",
    bool: null,
  },
  photo_of_place: {
    ask: (place: string) => `Send a current photo of the entrance of ${place}.`,
    answer: "Entrance photo attached.",
    bool: null,
  },
};
type Kind = keyof typeof KINDS;
type Place = { label: string; lat: number; lng: number; kinds: Kind[] };

const PLACES: Place[] = [
  {
    label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
    lat: 37.78246,
    lng: -122.40776,
    kinds: ["line_length", "is_open"],
  },
  {
    label: "Ferry Building, San Francisco",
    lat: 37.79554,
    lng: -122.39377,
    kinds: ["crowd_level", "line_length"],
  },
  {
    label: "Trader Joe's, 401 Bay St, San Francisco",
    lat: 37.80584,
    lng: -122.41481,
    kinds: ["in_stock", "line_length"],
  },
  {
    label: "Philz Coffee, 3101 24th St, San Francisco",
    lat: 37.75255,
    lng: -122.41466,
    kinds: ["line_length", "is_open"],
  },
  {
    label: "Tartine Bakery, 600 Guerrero St, San Francisco",
    lat: 37.76143,
    lng: -122.4241,
    kinds: ["line_length"],
  },
  {
    label: "Whole Foods Market, 2001 Market St, San Francisco",
    lat: 37.76857,
    lng: -122.42701,
    kinds: ["in_stock", "price_check"],
  },
  { label: "Safeway, 2020 Market St, San Francisco", lat: 37.76917, lng: -122.42797, kinds: ["price_check"] },
  { label: "Powell St BART Station, San Francisco", lat: 37.7844, lng: -122.40797, kinds: ["crowd_level"] },
  { label: "Embarcadero BART Station, San Francisco", lat: 37.7929, lng: -122.3971, kinds: ["crowd_level"] },
  {
    label: "Caltrain 4th & King Station, San Francisco",
    lat: 37.7766,
    lng: -122.3947,
    kinds: ["crowd_level", "is_open"],
  },
  {
    label: "Union Square, San Francisco",
    lat: 37.78795,
    lng: -122.4075,
    kinds: ["crowd_level", "photo_of_place"],
  },
  {
    label: "Dolores Park, San Francisco",
    lat: 37.7596,
    lng: -122.4269,
    kinds: ["crowd_level", "photo_of_place"],
  },
  { label: "Salesforce Park, San Francisco", lat: 37.7896, lng: -122.3966, kinds: ["is_open"] },
  {
    label: "Oracle Park, San Francisco",
    lat: 37.7786,
    lng: -122.3893,
    kinds: ["crowd_level", "line_length"],
  },
  { label: "City Lights Bookstore, San Francisco", lat: 37.7976, lng: -122.4065, kinds: ["is_open"] },
];

export type Planned = {
  agent: number;
  place: Place;
  kind: Kind;
  bounty_usd: number;
  fate: Fate;
  postAt: number;
  actAt: number;
  captureAt: number;
};

export function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function plan(agents: number, perAgent: number, seed = SEED): Planned[] {
  const rand = rng(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T;
  const after = (from: number, lo: number, hi: number) => from + lo + rand() * (hi - lo);
  return Array.from({ length: agents * perAgent }, (_, i): Planned => {
    const place = pick(PLACES);
    const roll = rand();
    const postAt = after(0, 0, POST_WINDOW_S);
    const actAt = after(postAt, 1, 5);
    return {
      agent: i % agents,
      place,
      kind: pick(place.kinds),
      bounty_usd: pick(BOUNTIES),
      fate: roll < 0.5 ? "paid" : roll < 0.7 ? "claimed" : roll < 0.85 ? "cancelled" : "expired",
      postAt,
      actAt,
      captureAt: after(actAt, 3, 8),
    };
  }).sort((a, b) => a.postAt - b.postAt);
}

export function workers(seed = SEED) {
  const rand = rng(seed + 1);
  return Array.from({ length: WORKER_COUNT }, (_, i) => {
    const home = PLACES[i % PLACES.length] as Place;
    const meters = 100 + rand() * 1100;
    const bearing = rand() * 2 * Math.PI;
    return {
      name: `Swarm Worker ${i + 1}`,
      phone: `+1415555${2000 + i}`,
      lat: home.lat + (meters * Math.cos(bearing)) / 111_320,
      lng: home.lng + (meters * Math.sin(bearing)) / (111_320 * Math.cos((home.lat * Math.PI) / 180)),
    };
  });
}

export function refusal(env: Env, allowRemote: boolean): string | null {
  if (env.EYES_PROVIDERS === "live") {
    return "EYES_PROVIDERS=live: the swarm only runs on fake providers and never texts, emails or pays anyone. Unset EYES_PROVIDERS or set it to fake.";
  }
  const url = env.DATABASE_URL;
  if (!url)
    return "Set DATABASE_URL to a migrated Postgres database, e.g. postgres://postgres:eyes@127.0.0.1:54329/eyes";
  const host = URL.canParse(url) ? new URL(url).hostname : "";
  if (allowRemote || LOCAL_HOSTS.has(host)) return null;
  return `DATABASE_URL points at ${host || "no host"}, not localhost. The swarm writes fake agents, workers, tasks and ledger rows; pass --allow-remote if that database is meant for it.`;
}

async function run(url: string, agentCount: number, perAgent: number) {
  let offsetMs = 0;
  const providers = {
    ...fakeProviders(),
    geo: fakeGeo(Object.fromEntries(PLACES.map((p) => [p.label.toLowerCase(), p]))),
    clock: { now: () => new Date(Date.now() + offsetMs) },
  };
  const service = createEyesService({
    db: { kind: "postgres", url },
    providers,
    assessTask: createAssessTask({}),
    verifySubmission,
    config: AppConfig.parse({
      public_api_url: "http://127.0.0.1:3000",
      worker_web_url: "http://127.0.0.1:4173",
      link_secret: randomUUID(),
      live_payouts: true,
    }),
  });
  const outbox = providers.messaging.outbox;

  for (const w of workers()) {
    await service.joinWorker(w);
    await service.handleWorkerReply({ phone: w.phone, intent: "start", text: "START" });
    const text = String(outbox.findLast((m) => m.to === w.phone && m.kind === "text")?.payload);
    // The START text has one link per line, so the token stops at the line end.
    await service.workerConnectUrl(/\/w\/connect\/(\S+)/.exec(text)?.[1] ?? "");
  }
  const agents: Agent[] = [];
  for (let i = 0; i < agentCount; i++) {
    const { api_key } = await service.signupAgent({ name: `swarm-agent-${i + 1}` });
    agents.push((await service.authenticate(api_key)) as Agent);
  }
  console.log(
    `${WORKER_COUNT} workers opted in around San Francisco, ${agentCount} agents signed up with $20 each`,
  );

  const started = Date.now();
  const say = (line: string) =>
    console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${line}`);
  const posted = new Map<Planned, { id: string; phones: string[]; token?: string }>();
  const open = new Map<string, { sentAt: number; deadline: number }>();
  const offers = new Map<string, string[]>();
  const busy = new Map<string, Planned>();
  const claimable = (phone: string) =>
    (busy.has(phone) ? [] : (offers.get(phone) ?? []))
      .filter((id) => (open.get(id)?.deadline ?? 0) > Date.now())
      .sort((a, b) => (open.get(b)?.sentAt ?? 0) - (open.get(a)?.sentAt ?? 0))[0];
  const name = (t: Planned) => t.place.label.replace(/,.*/, "");
  const queue: { at: number; run: () => Promise<unknown> }[] = [];
  const later = (seconds: number, run: () => Promise<unknown>) =>
    queue.push({ at: (Date.now() - started) / 1000 + seconds, run });
  const next = () => queue.sort((a, b) => a.at - b.at).shift();

  async function post(t: Planned) {
    const minutes = t.fate === "expired" ? EXPIRING_DEADLINE_MIN : DEADLINE_MIN;
    offsetMs = t.fate === "expired" ? (t.actAt - t.postAt - 1) * 1000 - minutes * 60_000 : 0;
    const from = outbox.length;
    const asked = await service
      .askEyes(agents[t.agent] as Agent, {
        question: KINDS[t.kind].ask(name(t)),
        location: t.place.label,
        task_type: t.kind,
        bounty_usd: t.bounty_usd,
        deadline_minutes: minutes,
        require_photo: true,
        idempotency_key: randomUUID(),
      })
      .finally(() => {
        offsetMs = 0;
      });
    const deadline = Date.parse(asked.deadline_at);
    const phones = outbox
      .slice(from)
      .filter((m) => m.kind === "offer")
      .map((m) => m.to);
    for (const phone of phones) offers.set(phone, [...(offers.get(phone) ?? []), asked.task_id]);
    open.set(asked.task_id, { sentAt: deadline - minutes * 60_000, deadline });
    posted.set(t, { id: asked.task_id, phones });
    say(`asked     ${t.kind} at ${name(t)}, ${asked.workers_notified} workers notified`);
  }

  async function claim(t: Planned): Promise<unknown> {
    const task = posted.get(t);
    if (!task) return;
    const phone = task.phones.find((p) => claimable(p) === task.id);
    if (!phone && Date.now() - started < CLAIM_CUTOFF_S * 1000) return later(2, () => claim(t));
    if (!phone) {
      const held = task.phones.filter((p) => busy.has(p)).length;
      return say(
        `no claim  ${name(t)}: ${held} of ${task.phones.length} notified workers busy, the rest hold newer offers`,
      );
    }
    await service.handleWorkerReply({ phone, intent: "yes", text: "YES" });
    const link = outbox.findLast((m) => m.to === phone && m.kind === "capture_link")?.payload as {
      task_id: string;
      capture_url: string;
    };
    if (link.task_id !== task.id) throw new Error(`worker claimed ${link.task_id}, expected ${task.id}`);
    open.delete(task.id);
    task.token = new URL(link.capture_url).searchParams.get("t") ?? "";
    busy.set(phone, t);
    say(`claimed   ${name(t)}`);
    if (t.fate === "paid") later(t.captureAt - t.actAt, () => capture(t));
  }

  async function capture(t: Planned) {
    const token = posted.get(t)?.token;
    if (!token) return;
    const kind = KINDS[t.kind];
    const result = await service.submitCapture(
      token,
      {
        lat: t.place.lat + 0.0001,
        lng: t.place.lng,
        accuracy_m: 10,
        captured_at: new Date().toISOString(),
        answer_text: kind.answer,
        answer_bool: kind.bool,
      },
      { bytes: JPEG, content_type: "image/jpeg" },
    );
    for (const [phone, held] of busy) if (held === t) busy.delete(phone);
    say(`${result.status.padEnd(9)} ${name(t)}: ${kind.answer}`);
  }

  async function cancel(t: Planned) {
    const task = posted.get(t);
    if (!task) return;
    const { refunded_usd } = await service.cancelTask(agents[t.agent] as Agent, { task_id: task.id });
    open.delete(task.id);
    say(`cancelled ${name(t)}, $${refunded_usd.toFixed(2)} refunded`);
  }

  async function expire() {
    const { expired } = await service.expireOverdue();
    if (expired > 0) say(`expired   ${expired} unclaimed task${expired === 1 ? "" : "s"}, escrow refunded`);
  }

  const act: Record<Fate, (t: Planned) => Promise<unknown>> = {
    paid: claim,
    claimed: claim,
    cancelled: cancel,
    expired: expire,
  };
  for (const t of plan(agentCount, perAgent)) {
    queue.push({ at: t.postAt, run: () => post(t) }, { at: t.actAt, run: () => act[t.fate](t) });
  }
  let skipped = 0;
  for (let event = next(); event; event = next()) {
    await sleep(Math.max(0, started + event.at * 1000 - Date.now()));
    await event.run().catch((err: unknown) => {
      skipped++;
      say(`skipped   ${err instanceof EyesError ? err.code : err instanceof Error ? err.message : err}`);
    });
  }

  type Feed = { tasks: { status: string }[]; ledger: { type: string }[]; workers: unknown[] };
  const rows = await createRpc({ kind: "postgres", url })<Feed>("eyes_dashboard_feed", { p_limit: 1000 });
  const feed = rows[0] as Feed;
  const tally = (xs: string[]) => {
    const counts = new Map<string, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    return [...counts].map(([k, v]) => `${v} ${k}`).join(", ");
  };
  return [
    `done in ${((Date.now() - started) / 1000).toFixed(0)}s, ${skipped} events skipped`,
    `dashboard feed now returns ${feed.tasks.length} tasks (${tally(feed.tasks.map((t) => t.status))})`,
    `  ${feed.ledger.length} ledger rows (${tally(feed.ledger.map((l) => l.type))}), ${feed.workers.length} workers`,
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      agents: { type: "string", default: "50" },
      tasks: { type: "string", default: "2" },
      "allow-remote": { type: "boolean", default: false },
    },
  });
  const agents = Number(values.agents);
  const tasks = Number(values.tasks);
  const refused =
    Number.isInteger(agents) && agents > 0 && Number.isInteger(tasks) && tasks > 0
      ? refusal(process.env, values["allow-remote"])
      : "--agents and --tasks must be positive integers, e.g. --agents 50 --tasks 2";
  if (refused) {
    console.error(refused);
    process.exit(1);
  }
  run(process.env.DATABASE_URL as string, agents, tasks).then(
    (summary) => process.stdout.write(`${summary}\n`, () => process.exit(0)),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
