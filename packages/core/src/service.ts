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
  cancelTask(agent: Agent, input: ToolInput<"cancel_task">): Promise<ToolOutput<"cancel_task">>;
  disputeAnswer(agent: Agent, input: ToolInput<"dispute_answer">): Promise<ToolOutput<"dispute_answer">>;
  getBalance(agent: Agent): Promise<ToolOutput<"get_balance">>;
  getSpendPolicy(agent: Agent): Promise<ToolOutput<"get_spend_policy">>;

  topupCheckoutUrl(token: string, amount_cents?: number): Promise<string>;
  creditTopup(input: { agent_id: string; amount_cents: number; stripe_ref: string }): Promise<void>;
  ownerConsole(token: string): Promise<OwnerConsole>;
  updateSpendPolicy(token: string, input: OwnerPolicyInput): Promise<ToolOutput<"get_spend_policy">>;

  joinWorker(input: JoinWorkerInput): Promise<JoinWorkerOutput>;
  workerConnectUrl(token: string): Promise<string>;
  markWorkerOnboarded(account_id: string): Promise<void>;
  handleWorkerReply(input: { phone: string; intent: ReplyIntent; text: string }): Promise<void>;
  getOffer(token: string): Promise<OfferView>;
  submitCapture(token: string, fields: CaptureFields, photo: PhotoUpload | null): Promise<CaptureResult>;

  expireOverdue(): Promise<{ expired: number }>;
  retryPayouts(): Promise<{ paid: number }>;
  resolveTask(
    task_id: string,
    decision: "refund" | "release",
    note: string,
  ): Promise<{ task_id: string; status: TaskStatus }>;
}

export const AppConfig = z.object({
  public_api_url: z.url(),
  worker_web_url: z.url(),
  link_secret: z.string().min(16),
  fee_cents: z.int().min(0).default(50),
  default_bounty_cents: z.int().min(100).default(300),
  dispatch_radius_m: z.int().min(100).default(3000),
  dispatch_max_workers: z.int().min(1).default(3),
  verify_radius_m: z.int().min(10).default(150),
  signup_grant_cents: z.int().min(0).default(2000),
  test_mode: z.boolean().default(true),
  email_domain: z.string().min(3).nullable().default(null),
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
