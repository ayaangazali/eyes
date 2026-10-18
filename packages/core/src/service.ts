import { z } from "zod";
import type { Providers, ReplyIntent, Vision } from "./providers.ts";
import type {
  Agent,
  CaptureFields,
  CaptureResult,
  JoinWorkerInput,
  JoinWorkerOutput,
  OfferView,
  OwnerConsole,
  OwnerPolicyInput,
  SignupInput,
  SignupOutput,
  Task,
  TaskStatus,
  TaskType,
  ToolInput,
  ToolOutput,
  WorkerEarnings,
  WorkerLocationInput,
} from "./schemas.ts";

export const SAFETY_CATEGORIES = [
  "private_person",
  "private_residence",
  "vehicle",
  "private_property",
  "identifiable_people",
  "following",
  "illegal_or_dangerous",
  "other",
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export type SafetyInput = { question: string; task_type: TaskType; place_label: string };
export type SafetyVerdict = {
  allowed: boolean;
  category: SafetyCategory | null;
  reason: string | null;
  fix: string | null;
  layer: "rules" | "classifier" | null;
};
export type AssessTask = (input: SafetyInput) => Promise<SafetyVerdict>;

export type VerifyInput = {
  task: Task;
  submission: {
    lat: number;
    lng: number;
    accuracy_m: number;
    captured_at: string;
    received_at: string;
    photo_url: string | null;
    answer_text: string | null;
    answer_bool: boolean | null;
  };
  vision: Vision;
};
export type VerificationResult = {
  gps_ok: boolean;
  fresh_ok: boolean;
  vision_ok: boolean;
  vision_reason: string;
  worker_distance_m: number;
  confidence: number;
  auto_approve: boolean;
};
export type VerifySubmission = (input: VerifyInput) => Promise<VerificationResult>;

export type PhotoUpload = { bytes: Uint8Array; content_type: string };

export interface EyesService {
  authenticate(apiKey: string): Promise<Agent | null>;
  agentById(agentId: string): Promise<Agent | null>;
  signupAgent(input: SignupInput): Promise<SignupOutput>;

  quoteTask(agent: Agent, input: ToolInput<"quote_task">): Promise<ToolOutput<"quote_task">>;
  askEyes(agent: Agent, input: ToolInput<"ask_eyes">): Promise<ToolOutput<"ask_eyes">>;
  awaitAnswer(
    agent: Agent,
    input: ToolInput<"await_answer">,
    signal?: AbortSignal,
  ): Promise<ToolOutput<"await_answer">>;
  getTask(agent: Agent, input: ToolInput<"get_task">): Promise<ToolOutput<"get_task">>;
  listTasks(agent: Agent, input: ToolInput<"list_tasks">): Promise<ToolOutput<"list_tasks">>;
  cancelTask(agent: Agent, input: ToolInput<"cancel_task">): Promise<ToolOutput<"cancel_task">>;
  disputeAnswer(agent: Agent, input: ToolInput<"dispute_answer">): Promise<ToolOutput<"dispute_answer">>;
  getBalance(agent: Agent): Promise<ToolOutput<"get_balance">>;
  getSpendPolicy(agent: Agent): Promise<ToolOutput<"get_spend_policy">>;

  topupCheckoutUrl(token: string, amount_cents?: number): Promise<string>;
  creditTopup(input: {
    agent_id: string;
    amount_cents: number;
    stripe_ref: string;
    payer_email?: string | null;
  }): Promise<void>;
  ownerConsole(token: string): Promise<OwnerConsole>;
  updateSpendPolicy(token: string, input: OwnerPolicyInput): Promise<ToolOutput<"get_spend_policy">>;
  rotateApiKey(token: string): Promise<{ api_key: string }>;

  joinWorker(input: JoinWorkerInput): Promise<JoinWorkerOutput>;
  workerConnectUrl(token: string): Promise<string>;
  markWorkerOnboarded(account_id: string): Promise<void>;
  handleWorkerReply(input: { phone: string; intent: ReplyIntent; text: string }): Promise<void>;
  workerEarnings(token: string): Promise<WorkerEarnings>;
  getOffer(token: string): Promise<OfferView>;
  submitCapture(token: string, fields: CaptureFields, photo: PhotoUpload | null): Promise<CaptureResult>;
  /** token: a 30-minute HERE token or the worker's long-lived location token. Throws unauthorized, invalid_input or rate_limited. */
  updateWorkerLocation(token: string, input: WorkerLocationInput): Promise<void>;
  /** code: the worker's location code. A 1-hour profile link to register an iPhone for ad hoc install, and that worker's device state. Throws unauthorized. */
  workerDevice(code: string): Promise<{ profile_url: string; registered: boolean; ready: boolean }>;
  /** ticket: from workerDevice's profile link. Stores the iPhone's UDID for that worker. Throws unauthorized. */
  addWorkerDevice(
    ticket: string,
    device: { udid: string; product: string | null; version: string | null },
  ): Promise<void>;

  expireOverdue(): Promise<{ expired: number }>;
  retryPayouts(): Promise<{ paid: number }>;
  resolveTask(
    task_id: string,
    decision: "refund" | "release",
    note: string,
  ): Promise<{ task_id: string; status: TaskStatus }>;
  resolveTicket(input: {
    ticket_id: number;
    outcome: "release" | "refund" | "close";
    note: string;
  }): Promise<{ ticket_id: number; task_id: string; status: "resolved" }>;
  /** Ops confirms a dispute is fraud, once: refund the agent, reverse the payout, ban the worker. */
  confirmFraud(input: { ticket_id: number; note: string }): Promise<DisputeOutcome>;
  /** Ops rejects a dispute, once: the answer stands and the worker keeps (or gets) the pay. */
  rejectDispute(input: { ticket_id: number; note: string }): Promise<DisputeOutcome>;
}

export type DisputeOutcome = {
  ticket_id: number;
  task_id: string;
  dispute_status: "upheld" | "rejected";
  agent_refund_cents: number;
  /** Only reported on the first call; a repeat call says "none" unless money is still owed. */
  reversal: "reversed" | "owed" | "none";
  reversal_owed_cents: number | null;
  worker_banned: boolean;
  already_resolved: boolean;
};

export const AppConfig = z.object({
  public_api_url: z.url(),
  worker_web_url: z.url(),
  link_secret: z.string().min(16),
  fee_cents: z.int().min(0).default(50),
  default_bounty_cents: z.int().min(100).default(300),
  dispatch_radius_m: z.int().min(100).default(3000),
  dispatch_max_workers: z.int().min(1).default(3),
  verify_radius_m: z.int().min(10).default(150),
  location_max_age_h: z.int().min(1).default(24),
  location_ping: z.boolean().default(false),
  location_min_interval_s: z.int().min(1).default(30),
  location_daily_max: z.int().min(1).default(1500),
  signup_grant_cents: z.int().min(0).default(2000),
  test_mode: z.boolean().default(true),
  email_domain: z.string().min(3).nullable().default(null),
  email_delivery: z.boolean().default(false),
  live_payouts: z.boolean().default(false),
  testflight_url: z
    .string()
    .regex(
      /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+\/?$/,
      "EYES_TESTFLIGHT_URL must be https://testflight.apple.com/join/XXXX",
    )
    .optional(),
});
export type AppConfig = z.output<typeof AppConfig>;

export type DbConfig =
  | { kind: "postgres"; url: string }
  | { kind: "insforge"; base_url: string; api_key: string };

export type EngineDeps = {
  db: DbConfig;
  providers: Providers;
  assessTask: AssessTask;
  verifySubmission: VerifySubmission;
  config: AppConfig;
};

export type RouteDeps = { service: EyesService; providers: Providers; config: AppConfig };
