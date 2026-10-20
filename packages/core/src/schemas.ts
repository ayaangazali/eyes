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
const ValidText = z.refine<string>(
  (value) => !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0"),
  "Remove NUL characters and replace unpaired Unicode surrogates.",
);
const InputText = z.string().check(ValidText);

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
  email: z.string().nullable().optional(),
  email_verified_at: Timestamp.nullable().optional(),
  email_skipped: z.boolean().optional(),
  app_connected: z.boolean().optional(),
  name: z.string(),
  stripe_account_id: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  location_at: Timestamp.nullable(),
  available: z.boolean(),
  opted_in: z.boolean(),
  rating: z.number().min(0).max(5),
  banned: z.boolean().optional(),
  dispute_hold_at: Timestamp.nullable().optional(),
  dispute_reviewed_at: Timestamp.nullable().optional(),
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
  accepted_at: Timestamp.nullable().optional(),
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
  vision_ok: z.boolean().nullable(),
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
    InputText.min(2)
      .refine((value) => {
        const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
        return !coords || LatLng.safeParse({ lat: Number(coords[1]), lng: Number(coords[2]) }).success;
      }, "Coordinates must have latitude from -90 to 90 and longitude from -180 to 180.")
      .max(200)
      .describe(
        'A public place as "place name, city" or its street address, e.g. "Blue Bottle Coffee, Mint Plaza, San Francisco". Never a home address.',
      ),
  ])
  .describe(
    'The public place to check: a string "place name, city" or its numbers {"lat": 37.7825, "lng": -122.4078}. Never the user\'s own location or a home address.',
  );

export const ResolvedLocation = LatLng.extend({ label: z.string() });

const TaskId = Id.describe("The task_id returned by ask_eyes.");
const Usd = z.number();

export const Verification = z.object({
  gps_ok: z.boolean().describe("The worker was within about 150 m of the place."),
  fresh_ok: z.boolean().describe("The photo was taken live, before the deadline."),
  vision_ok: z
    .boolean()
    .describe(
      "The photo check completed without confirmed graphic gore or explicit sexual content. Content uncertainty alone passes; provider failures need review. It does not mean the answer is correct.",
    ),
  vision_reason: z.string().describe("Why the photo is or is not safe to share."),
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
  suggested_bounty_usd: Usd.describe(
    "A bounty ask_eyes accepts for this API key right now: the default, lowered to fit max_bounty_usd, the daily cap left after the fee, and your balance after the fee. Pass it as bounty_usd.",
  ),
  allowed: z
    .boolean()
    .describe(
      "False when this API key cannot post this task right now: Eyes' safety rules refuse this task_type at this place, the task_type is not in allowed_task_types, or even the 1 USD minimum bounty plus fee does not fit max_bounty_usd, the daily cap left or the balance. It does not check your question: ask_eyes checks the question itself and can still refuse it with unsafe_task.",
    ),
  reason_if_not: z
    .string()
    .nullable()
    .describe(
      "Why allowed is false and what to do: change the place or task_type, top up at top_up_url, wait for the daily cap to reset at midnight UTC, or ask your user to raise a limit. Null when allowed is true.",
    ),
  resolved_location: ResolvedLocation,
});

export const ClassifierReportId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine(
    (value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
    "Ticket id exceeds the supported range.",
  );
export const AskEyesInput = z.object({
  question: InputText.min(5)
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
    .string({
      error:
        "Required. Pass any unique string for each task you intend to create, for example a UUID, and send the same key again when you retry that task, so the retry returns the original task instead of charging twice.",
    })
    .check(ValidText)
    .min(1, "Must not be empty. Pass any unique string for each task, for example a UUID.")
    .max(128, "At most 128 characters. Pass a shorter unique string, for example a UUID (36 characters).")
    .describe(
      "Required. Any unique string for each task you intend to create, for example a UUID. Reuse it when you retry that task: the same key and parameters return the original task and never charge twice. Use a new key for a new question.",
    ),
  classifier_report_id: ClassifierReportId.optional().describe(
    "Approved classifier feedback ticket for this exact request and API agent. Never grants permission for a changed request.",
  ),
});
export const AskEyesOutput = z.object({
  task_id: Id,
  resolved_location: ResolvedLocation,
  status: TaskStatus.describe(
    "New tasks are dispatched. A retry returns the stored task status, without another charge or policy check.",
  ),
  workers_notified: z.int().min(0),
  escrowed_usd: Usd,
  deadline_at: Timestamp,
  next_step: z.string(),
});

export const AskEyesDraftInput = AskEyesInput.extend({
  bounty_usd: AskEyesInput.shape.bounty_usd.describe(
    "Proposed payment to the human who answers. Only after the user confirms in the card, this bounty plus a $0.50 fee is escrowed and refunded if nobody answers. Preparing this draft charges nothing.",
  ),
  deadline_minutes: AskEyesInput.shape.deadline_minutes.describe(
    "Minutes from confirmed dispatch until the task expires and the escrow is refunded. Preparing this draft does not start the deadline.",
  ),
  idempotency_key: AskEyesInput.shape.idempotency_key.describe(
    "Required unique key for this draft intent. The card passes the same key and exact confirmed parameters to confirm_ask; retries reuse them, while an intentional new Ask uses a new key.",
  ),
});
export const AskEyesDraftOutput = AskEyesDraftInput.extend({
  ...QuoteTaskOutput.shape,
  suggested_bounty_usd: QuoteTaskOutput.shape.suggested_bounty_usd.describe(
    "Suggested bounty for a later confirmed task, limited by this API key's limits and balance after the $0.50 fee. No money is reserved by this draft; confirm_ask rechecks limits before dispatch.",
  ),
  allowed: QuoteTaskOutput.shape.allowed.describe(
    "Whether this place, task type, balance and spend limits currently permit a task. This quote does not check the question; confirmed dispatch rechecks question safety and spending before creating a task.",
  ),
  status: z.literal("confirmation_required"),
  next_step: z.string(),
});

// MCP-only envelope. REST and programmatic core callers keep AskEyesOutput unchanged.
export const AskEyesMcpOutput = z.object({
  ...AskEyesInput.partial().shape,
  ...QuoteTaskOutput.partial().shape,
  status: z
    .enum(["confirmation_required", "not_sent", ...TASK_STATUSES])
    .describe(
      '"confirmation_required": read-only draft, nothing sent or charged. "not_sent": nobody nearby, nothing created or charged. Otherwise, the stored task status; retries report its current status and money held.',
    ),
  task_id: AskEyesOutput.shape.task_id.optional(),
  workers_notified: AskEyesOutput.shape.workers_notified.optional(),
  escrowed_usd: AskEyesOutput.shape.escrowed_usd.optional(),
  deadline_at: AskEyesOutput.shape.deadline_at.optional(),
  next_step: AskEyesOutput.shape.next_step.optional(),
  reason: z.literal("no_workers_nearby").optional(),
  charged_usd: z.number().optional(),
  message: z.string().optional(),
  fix: z.string().optional(),
});

export const ReportClassifierInput = AskEyesInput.omit({ classifier_report_id: true }).extend({
  ask_idempotency_key: AskEyesInput.shape.idempotency_key.describe(
    "The original refused Ask key. The top-level idempotency_key is the separate per-card report key.",
  ),
  classifier_error: z
    .object({
      error: z.literal("unsafe_task"),
      message: InputText.max(4000).optional(),
      fix: InputText.max(4000).optional(),
    })
    .catchall(z.json())
    .refine((value) => JSON.stringify(value).length <= 16000, "Classifier context exceeds 16000 characters."),
  task_id: Id.optional(),
});
export const GetClassifierReportInput = z.object({ ticket_id: ClassifierReportId });
export const ClassifierReportOutput = z.object({
  ticket_id: ClassifierReportId,
  status: z.enum(["open", "approved", "rejected", "expired", "consumed"]),
  approval_expires_at: Timestamp.optional(),
  reason: z.string().optional(),
  task_id: Id.optional(),
});
export const ReportClassifierOutput = ClassifierReportOutput.extend({ created: z.boolean() });

export const AwaitAnswerInput = z.object({
  task_id: TaskId.describe(
    "Existing task_id from confirmed dispatch or a task lookup. Not a draft idempotency_key.",
  ),
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
  accepted_at: Timestamp.nullable()
    .optional()
    .describe("When your agent accepted this answer. Feedback only; not photo verification or payment."),
  next_step: z.string(),
});

export const RetryContext = z.object({
  question: z.string(),
  location: z.object({ lat: z.number(), lng: z.number(), label: z.string() }),
  task_type: TaskType,
  bounty_usd: Usd,
  deadline_minutes: AskEyesInput.shape.deadline_minutes.optional(),
  require_photo: AskEyesInput.shape.require_photo.optional(),
});

export const GetTaskInput = z.object({ task_id: TaskId });
export const GetTaskOutput = z.object({
  task_id: Id,
  retry_context: RetryContext,
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
  accepted_at: Timestamp.nullable()
    .optional()
    .describe("When your agent accepted this answer. Feedback only; not photo verification or payment."),
  dispute: z
    .object({
      status: z
        .enum(["open", "upheld", "rejected"])
        .describe(
          "open: a person is reviewing your dispute. upheld: the answer was fake; bounty and fee were refunded to your balance. rejected: the answer stands and the worker keeps the pay.",
        ),
      refunded_usd: Usd.nullable().describe("What was refunded to your balance when the dispute was upheld."),
    })
    .nullable()
    .describe("Your dispute_answer on this task and its outcome; null if you never disputed it."),
});

export const ListTasksInput = z.object({
  status: TaskStatus.optional().describe(
    'Only return tasks in this status, e.g. "dispatched" for tasks no worker has claimed yet. Omit for every status.',
  ),
  limit: z.int().min(1).max(50).default(20).describe("How many tasks to return, newest first. 1 to 50."),
  before: Id.optional().describe(
    "Cursor from next_cursor for the next page. Keep the same status filter. Omit for the newest tasks.",
  ),
});
export const ListTasksOutput = z.object({
  tasks: z
    .array(
      z.object({
        task_id: Id,
        status: TaskStatus,
        accepted_at: Timestamp.nullable().optional(),
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
  next_cursor: Id.nullable().describe("Pass as before for older tasks; null means no more tasks."),
  next_step: z.string(),
});

export const CancelTaskInput = z.object({ task_id: TaskId });
export const CancelTaskOutput = z.object({
  task_id: Id,
  status: z.literal("refunded"),
  refunded_usd: Usd,
});

export const AcceptAnswerInput = z.object({ task_id: TaskId });
export const AcceptAnswerOutput = z.object({
  task_id: Id,
  status: z.literal("accepted").describe("Your agent's positive feedback, not machine verification."),
  accepted_at: Timestamp,
});

export const DisputeAnswerInput = z.object({
  task_id: TaskId,
  reason: InputText.min(5)
    .max(1000)
    .describe('What is wrong with the answer, e.g. "photo shows a different store".'),
});
export const DisputeAnswerOutput = z.object({
  task_id: Id,
  status: z.literal("disputed"),
  retry_context: RetryContext,
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
  max_bounty_usd: z.number().min(0).max(50),
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
  name: InputText.min(2).max(80),
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
  report_classifier: { input: ReportClassifierInput, output: ReportClassifierOutput },
  get_classifier_report: { input: GetClassifierReportInput, output: ClassifierReportOutput },
  await_answer: { input: AwaitAnswerInput, output: AwaitAnswerOutput },
  get_task: { input: GetTaskInput, output: GetTaskOutput },
  list_tasks: { input: ListTasksInput, output: ListTasksOutput },
  cancel_task: { input: CancelTaskInput, output: CancelTaskOutput },
  accept_answer: { input: AcceptAnswerInput, output: AcceptAnswerOutput },
  dispute_answer: { input: DisputeAnswerInput, output: DisputeAnswerOutput },
  get_balance: { input: GetBalanceInput, output: GetBalanceOutput },
  get_spend_policy: { input: GetSpendPolicyInput, output: GetSpendPolicyOutput },
} as const;
export type ToolName = keyof typeof TOOLS;
export type ToolInput<T extends ToolName> = z.output<(typeof TOOLS)[T]["input"]>;
export type ToolOutput<T extends ToolName> = z.output<(typeof TOOLS)[T]["output"]>;

export const WorkerEmail = z.email().max(254).toLowerCase();

export const JoinWorkerInput = z
  .object({
    name: InputText.min(2).max(80),
    phone: Phone,
    email: WorkerEmail.optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .refine((v) => v.lat !== 0 || v.lng !== 0, { message: "0,0 is not a real location.", path: ["lat"] });
export const JoinWorkerOutput = z.object({
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
  answer_text: InputText.max(1000).nullable().default(null),
  answer_bool: z.boolean().nullable().default(null),
});
// iPhone Shortcuts send numbers as strings, with a comma decimal in many locales.
const LooseNumber = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() ? Number(v.trim().replace(",", ".")) : undefined) : v),
  z.number(),
);
export const WorkerLocationInput = z
  .object({
    lat: LooseNumber.pipe(z.number().min(-90).max(90)),
    lng: LooseNumber.pipe(z.number().min(-180).max(180)),
    accuracy_m: LooseNumber.pipe(z.number().min(0)).optional().catch(undefined),
    source: z.enum(["shortcut", "here_link", "capture", "findmy", "app"]),
    input: z.string().max(500).optional().catch(undefined),
    captured_at: Timestamp.optional().catch(undefined),
  })
  .refine((v) => v.lat !== 0 || v.lng !== 0, { message: "0,0 is not a real location.", path: ["lat"] });
export type WorkerLocationInput = z.input<typeof WorkerLocationInput>;
// One row of the worker's task list on /me (T6.42, ADR-029). payout: the payout label rule (ADR-020).
export const WorkerTask = z.object({
  task_id: Id,
  question: z.string(),
  place_label: z.string(),
  status: TaskStatus,
  bounty_usd: Usd,
  payout: z.enum(["paid", "pending", "waiting_for_payout_setup"]).nullable(),
  claimed_at: Timestamp,
});
export const WORKER_TASK_FILTERS = ["paid", "pending", "review", "expired"] as const;
// GET /w/me/tasks: one page of the worker's tasks, newest first, plus the totals over all of them.
export const WorkerTasks = z.object({
  paid_usd: Usd,
  pending_usd: Usd,
  tasks: z.array(WorkerTask).max(100),
  next_cursor: z.string().nullable(),
});
export const WorkerTasksQuery = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.enum(WORKER_TASK_FILTERS).optional().catch(undefined),
  cursor: z.string().max(100).optional().catch(undefined),
  tz: z.string().max(64).optional().catch(undefined),
});
// The worker's setup page, /me (ADR-028). Its task list loads from GET /w/me/tasks.
export const WorkerSetup = z.object({
  opted_in: z.boolean(),
  spot: z.object({ at: Timestamp.nullable(), fresh: z.boolean(), max_age_h: z.number() }),
  app: z.object({ connected: z.boolean(), last_at: Timestamp.nullable(), sending: z.boolean() }),
  payouts: z.object({ set_up: z.boolean(), live: z.boolean(), setup_url: z.string().nullable() }),
  here_url: z.string(),
  /** j…@example.com; the full address is never returned. */
  email_masked: z.string().nullable(),
  email_status: z.enum(["none", "pending", "verified"]),
  email_skipped: z.boolean(),
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
export type WorkerTask = z.output<typeof WorkerTask>;
export type WorkerTasks = z.output<typeof WorkerTasks>;
export type WorkerTasksQuery = z.output<typeof WorkerTasksQuery>;
export type WorkerSetup = z.output<typeof WorkerSetup>;

export const HTTP_ROUTES = {
  health: "GET /healthz",
  mcp: "POST /mcp",
  signup: "POST /v1/signup",
  quote: "POST /v1/quote",
  report_classifier: "POST /v1/classifier-reports",
  get_classifier_report: "GET /v1/classifier-reports/:ticket_id",
  ask: "POST /v1/tasks",
  get_task: "GET /v1/tasks/:task_id",
  list_tasks: "GET /v1/tasks",
  await_answer: "POST /v1/tasks/:task_id/await",
  cancel_task: "POST /v1/tasks/:task_id/cancel",
  accept_answer: "POST /v1/tasks/:task_id/accept",
  dispute_answer: "POST /v1/tasks/:task_id/dispute",
  get_balance: "GET /v1/balance",
  get_spend_policy: "GET /v1/spend-policy",
  topup_redirect: "GET /topup/:token",
  owner_console: "GET /owner/:token",
  owner_policy: "POST /owner/:token/policy",
  owner_rotate_key: "POST /owner/:token/rotate-key",
  worker_join: "POST /w/join",
  worker_connect_redirect: "GET /w/connect/:token",
  worker_earnings: "GET /w/earnings/:token",
  worker_me: "GET /w/me",
  worker_me_tasks: "GET /w/me/tasks",
  worker_me_install: "POST /w/me/install",
  worker_me_email_skip: "POST /w/me/email/skip",
  offer_view: "GET /w/offers/:token",
  offer_capture: "POST /w/offers/:token/capture",
  worker_device: "POST /w/device",
  worker_device_profile: "GET /w/device/profile/:ticket",
  worker_device_register: "POST /w/device/:ticket",
  worker_app_manifest: "GET /w/app/manifest.plist",
  worker_app_ipa: "GET /w/app/Eyes.ipa",
  webhook_inkbox: "POST /webhooks/inkbox",
  webhook_primitive: "POST /webhooks/primitive",
  webhook_stripe: "POST /webhooks/stripe",
  llms_txt: "GET /llms.txt",
  llms_full_txt: "GET /llms-full.txt",
  openapi: "GET /openapi.json",
  agent_card: "GET /.well-known/agent-card.json",
} as const;
