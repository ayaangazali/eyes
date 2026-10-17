import { z } from "zod";

export const TASK_TYPES = [
  "is_open",
  "line_length",
  "in_stock",
  "photo_of_place",
  "price_check",
  "crowd_level",
  "other_public",
] as const;
export const TaskType = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskType>;

export const TASK_STATUSES = [
  "dispatched",
  "claimed",
  "submitted",
  "verified",
  "paid",
  "expired",
  "refunded",
  "disputed",
  "needs_review",
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const LEDGER_TYPES = ["topup", "escrow", "release", "refund", "payout", "fee"] as const;
export const LedgerType = z.enum(LEDGER_TYPES);
export type LedgerType = z.infer<typeof LedgerType>;

const Id = z.uuid();
const Cents = z.int();
const Timestamp = z.iso.datetime({ offset: true });
const Phone = z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 phone number, e.g. +14155550123");

export const LatLng = z.object({
  lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees, e.g. 37.7825"),
  lng: z.number().min(-180).max(180).describe("Longitude in decimal degrees, e.g. -122.4078"),
});
export type LatLng = z.infer<typeof LatLng>;

export const Agent = z.object({
  id: Id,
  name: z.string(),
  api_key_hash: z.string(),
  email_identity: z.string().nullable(),
  balance_cents: Cents,
  daily_cap_cents: Cents,
  max_bounty_cents: Cents,
  allowed_task_types: z.array(TaskType),
  created_at: Timestamp,
});
export type Agent = z.infer<typeof Agent>;

export const Worker = z.object({
  id: Id,
  phone: Phone,
  name: z.string(),
  stripe_account_id: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  available: z.boolean(),
  opted_in: z.boolean(),
  rating: z.number().min(0).max(5),
  created_at: Timestamp,
});
export type Worker = z.infer<typeof Worker>;

export const Task = z.object({
  id: Id,
  agent_id: Id,
  question: z.string(),
  task_type: TaskType,
  place_label: z.string(),
  lat: z.number(),
  lng: z.number(),
  radius_m: z.int(),
  bounty_cents: Cents,
  fee_cents: Cents,
  require_photo: z.boolean(),
  deadline_at: Timestamp,
  status: TaskStatus,
  claimed_by: Id.nullable(),
  claimed_at: Timestamp.nullable(),
  idempotency_key: z.string().nullable(),
  dispute_reason: z.string().nullable(),
  created_at: Timestamp,
});
export type Task = z.infer<typeof Task>;

export const Submission = z.object({
  id: Id,
  task_id: Id,
  worker_id: Id,
  photo_url: z.string().nullable(),
  answer_text: z.string().nullable(),
  answer_bool: z.boolean().nullable(),
  lat: z.number(),
  lng: z.number(),
  captured_at: Timestamp,
  gps_ok: z.boolean(),
  fresh_ok: z.boolean(),
  vision_ok: z.boolean(),
  vision_reason: z.string(),
  confidence: z.number().min(0).max(1),
  source: z.enum(["capture", "email"]),
  created_at: Timestamp,
});
export type Submission = z.infer<typeof Submission>;

export const LedgerEntry = z.object({
  id: Id,
  agent_id: Id.nullable(),
  worker_id: Id.nullable(),
  task_id: Id.nullable(),
  type: LedgerType,
  amount_cents: z.int().positive(),
  stripe_ref: z.string().nullable(),
  created_at: Timestamp,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const LocationInput = z
  .union([
    LatLng,
    z
      .string()
      .min(2)
      .max(200)
      .describe('Address or "place name, city", e.g. "Blue Bottle Coffee, Mint Plaza, San Francisco"'),
  ])
  .describe(
    'Where to look. Either numbers {"lat": 37.7825, "lng": -122.4078} or a string address / "place name, city".',
  );

export const ResolvedLocation = z.object({ lat: z.number(), lng: z.number(), label: z.string() });

const TaskId = Id.describe("The task_id returned by ask_eyes.");
const Usd = z.number();

export const Verification = z.object({
  gps_ok: z.boolean(),
  fresh_ok: z.boolean(),
  vision_ok: z.boolean(),
  vision_reason: z.string(),
});
export type Verification = z.infer<typeof Verification>;

export const Answer = z.object({
  task_id: Id,
  answer_text: z.string(),
  answer_bool: z.boolean().nullable(),
  photo_url: z.string().nullable(),
  captured_at: Timestamp,
  worker_distance_m: z.number(),
  verification: Verification,
  confidence: z.number().min(0).max(1),
  worker_rating: z.number(),
  cost_usd: Usd,
});
export type Answer = z.infer<typeof Answer>;

export const QuoteTaskInput = z.object({ location: LocationInput, task_type: TaskType });
export const QuoteTaskOutput = z.object({
  workers_nearby: z.int().min(0),
  est_minutes_to_answer: z.number().nullable(),
  suggested_bounty_usd: Usd,
  allowed: z
    .boolean()
    .describe(
      "Whether Eyes' safety rules accept this task_type at this place. It does not check your question (ask_eyes checks the question itself and can still refuse it with unsafe_task) or your spend policy and balance (see get_spend_policy and get_balance).",
    ),
  reason_if_not: z
    .string()
    .nullable()
    .describe(
      "Why allowed is false and what to change about the place or task_type; null when allowed is true.",
    ),
  resolved_location: ResolvedLocation,
});

export const AskEyesInput = z.object({
  question: z
    .string()
    .min(5)
    .max(500)
    .describe('What the human should check, in plain words, e.g. "How many people are in line right now?"'),
  location: LocationInput,
  task_type: TaskType.describe(
    "is_open: open or closed now; line_length: how long the line is; in_stock: whether an item is on the shelf; photo_of_place: a current photo; price_check: a posted price; crowd_level: how busy it is; other_public: any other check of a public place.",
  ),
  bounty_usd: z
    .number()
    .min(1)
    .max(50)
    .default(3)
    .describe(
      "Paid to the human who answers. A $0.50 fee is added. Both are escrowed now and refunded if nobody answers.",
    ),
  deadline_minutes: z
    .int()
    .min(5)
    .max(240)
    .default(30)
    .describe("Minutes until the task expires and the escrow is refunded."),
  require_photo: z
    .boolean()
    .default(true)
    .describe(
      "Require a live photo. Keep true unless a text answer is enough; photos are what make an answer verifiable.",
    ),
  idempotency_key: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Any unique string per question. Retrying with the same key never double-charges. Always set it.",
    ),
});
export const AskEyesOutput = z.object({
  task_id: Id,
  status: z.literal("dispatched"),
  workers_notified: z.int().min(0),
  escrowed_usd: Usd,
  deadline_at: Timestamp,
  next_step: z.string(),
});

export const AwaitAnswerInput = z.object({
  task_id: TaskId,
  timeout_seconds: z
    .int()
    .min(1)
    .max(55)
    .default(50)
    .describe(
      "How long this call waits for an answer, at most 55 seconds. Call again while answered is false and the status is dispatched, claimed or submitted; stop on expired, refunded or disputed.",
    ),
});
export const AwaitAnswerOutput = z.object({
  task_id: Id,
  status: TaskStatus,
  answered: z.boolean(),
  answer: Answer.nullable(),
  next_step: z.string(),
});

export const GetTaskInput = z.object({ task_id: TaskId });
export const GetTaskOutput = z.object({
  task_id: Id,
  status: TaskStatus,
  question: z.string(),
  task_type: TaskType,
  place_label: z.string(),
  bounty_usd: Usd,
  fee_usd: Usd,
  deadline_at: Timestamp,
  created_at: Timestamp,
  claimed_at: Timestamp.nullable(),
  answer: Answer.nullable(),
});

export const ListTasksInput = z.object({
  status: TaskStatus.optional().describe(
    'Only return tasks in this status, e.g. "dispatched" for tasks no worker has claimed yet. Omit for every status.',
  ),
  limit: z.int().min(1).max(50).default(20).describe("How many tasks to return, newest first. 1 to 50."),
});
export const ListTasksOutput = z.object({
  tasks: z
    .array(
      z.object({
        task_id: Id,
        status: TaskStatus,
        question: z.string(),
        place_label: z.string(),
        bounty_usd: Usd,
        created_at: Timestamp,
        deadline_at: Timestamp,
        answered: z
          .boolean()
          .describe("True when status is verified, paid or needs_review; get_task returns the answer."),
      }),
    )
    .max(50),
  next_step: z.string(),
});

export const CancelTaskInput = z.object({ task_id: TaskId });
export const CancelTaskOutput = z.object({
  task_id: Id,
  status: z.literal("refunded"),
  refunded_usd: Usd,
});

export const DisputeAnswerInput = z.object({
  task_id: TaskId,
  reason: z
    .string()
    .min(5)
    .max(1000)
    .describe('What is wrong with the answer, e.g. "photo shows a different store".'),
});
export const DisputeAnswerOutput = z.object({
  task_id: Id,
  status: z.literal("disputed"),
  next_step: z.string(),
});

export const GetBalanceInput = z.object({});
export const GetBalanceOutput = z.object({
  balance_usd: Usd,
  escrowed_usd: Usd,
  top_up_url: z.string().nullable(),
});

export const GetSpendPolicyInput = z.object({});
export const GetSpendPolicyOutput = z.object({
  max_bounty_usd: Usd,
  daily_cap_usd: Usd,
  spent_today_usd: Usd,
  remaining_today_usd: Usd,
  allowed_task_types: z.array(TaskType),
});

export const OwnerPolicyInput = z.object({
  max_bounty_usd: z.number().min(0).max(100),
  daily_cap_usd: z.number().min(0).max(1000),
  allowed_task_types: z.array(TaskType),
});
export const OwnerConsole = z.object({
  agent_id: Id,
  agent_name: z.string(),
  balance_usd: Usd,
  escrowed_usd: Usd,
  policy: GetSpendPolicyOutput,
  tasks: z
    .array(
      z.object({
        task_id: Id,
        question: z.string(),
        place_label: z.string(),
        status: TaskStatus,
        bounty_usd: Usd,
        created_at: Timestamp,
      }),
    )
    .max(20),
  ledger: z
    .array(z.object({ type: LedgerType, amount_usd: Usd, task_id: Id.nullable(), created_at: Timestamp }))
    .max(50),
  top_up_url: z.string().nullable(),
});

export const SignupInput = z.object({
  name: z.string().min(2).max(80),
  owner_email: z.email().optional(),
});
export const SignupOutput = z.object({
  agent_id: Id,
  api_key: z.string(),
  balance_usd: Usd,
  top_up_url: z.string().nullable(),
  email_address: z
    .string()
    .nullable()
    .describe(
      "Private address for asking Eyes by email. Anyone who knows it can spend your balance, so keep it secret.",
    ),
  next_step: z.string(),
});

export const TOOLS = {
  quote_task: { input: QuoteTaskInput, output: QuoteTaskOutput },
  ask_eyes: { input: AskEyesInput, output: AskEyesOutput },
  await_answer: { input: AwaitAnswerInput, output: AwaitAnswerOutput },
  get_task: { input: GetTaskInput, output: GetTaskOutput },
  list_tasks: { input: ListTasksInput, output: ListTasksOutput },
  cancel_task: { input: CancelTaskInput, output: CancelTaskOutput },
  dispute_answer: { input: DisputeAnswerInput, output: DisputeAnswerOutput },
  get_balance: { input: GetBalanceInput, output: GetBalanceOutput },
  get_spend_policy: { input: GetSpendPolicyInput, output: GetSpendPolicyOutput },
} as const;
export type ToolName = keyof typeof TOOLS;
export type ToolInput<T extends ToolName> = z.output<(typeof TOOLS)[T]["input"]>;
export type ToolOutput<T extends ToolName> = z.output<(typeof TOOLS)[T]["output"]>;

export const JoinWorkerInput = z.object({
  name: z.string().min(2).max(80),
  phone: Phone,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export const JoinWorkerOutput = z.object({
  worker_id: Id,
  opt_in_instructions: z.string(),
  inkbox_number: z.string().nullable(),
  connect_url: z.string().nullable(),
});

export const OfferView = z.object({
  task_id: Id,
  question: z.string(),
  task_type: TaskType,
  place_label: z.string(),
  lat: z.number(),
  lng: z.number(),
  radius_m: z.int(),
  bounty_usd: Usd,
  deadline_at: Timestamp,
  require_photo: z.boolean(),
  status: TaskStatus,
  claimed_by_you: z.boolean(),
});

export const CaptureFields = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy_m: z.coerce.number().min(0),
  captured_at: Timestamp,
  answer_text: z.string().max(1000).nullable().default(null),
  answer_bool: z.boolean().nullable().default(null),
});
export const CaptureResult = z.object({
  task_id: Id,
  status: TaskStatus,
  verification: Verification,
  message: z.string(),
});

export type QuoteTaskInput = z.output<typeof QuoteTaskInput>;
export type AskEyesInput = z.output<typeof AskEyesInput>;
export type SignupInput = z.output<typeof SignupInput>;
export type SignupOutput = z.output<typeof SignupOutput>;
export type JoinWorkerInput = z.output<typeof JoinWorkerInput>;
export type JoinWorkerOutput = z.output<typeof JoinWorkerOutput>;
export type OfferView = z.output<typeof OfferView>;
export type CaptureFields = z.output<typeof CaptureFields>;
export type CaptureResult = z.output<typeof CaptureResult>;
export type ResolvedLocation = z.output<typeof ResolvedLocation>;
export type OwnerPolicyInput = z.output<typeof OwnerPolicyInput>;
export type OwnerConsole = z.output<typeof OwnerConsole>;

export const HTTP_ROUTES = {
  health: "GET /healthz",
  mcp: "POST /mcp",
  signup: "POST /v1/signup",
  quote: "POST /v1/quote",
  ask: "POST /v1/tasks",
  get_task: "GET /v1/tasks/:task_id",
  list_tasks: "GET /v1/tasks",
  await_answer: "POST /v1/tasks/:task_id/await",
  cancel_task: "POST /v1/tasks/:task_id/cancel",
  dispute_answer: "POST /v1/tasks/:task_id/dispute",
  get_balance: "GET /v1/balance",
  get_spend_policy: "GET /v1/spend-policy",
  topup_redirect: "GET /topup/:token",
  owner_console: "GET /owner/:token",
  owner_policy: "POST /owner/:token/policy",
  worker_join: "POST /w/join",
  worker_connect_redirect: "GET /w/connect/:token",
  offer_view: "GET /w/offers/:token",
  offer_capture: "POST /w/offers/:token/capture",
  webhook_inkbox: "POST /webhooks/inkbox",
  webhook_primitive: "POST /webhooks/primitive",
  webhook_stripe: "POST /webhooks/stripe",
  llms_txt: "GET /llms.txt",
  llms_full_txt: "GET /llms-full.txt",
  openapi: "GET /openapi.json",
  agent_card: "GET /.well-known/agent-card.json",
} as const;
