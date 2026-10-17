export const ERRORS = {
  unauthorized: {
    status: 401,
    message: "Missing or invalid API key.",
    fix: "Send the header Authorization: Bearer <api_key>. No key yet? POST /v1/signup (or run `eyes signup`) to create one.",
  },
  invalid_input: {
    status: 400,
    message: "The request did not match the expected schema.",
    fix: "Correct the fields listed in `issues` and retry. Each tool's input schema documents every field.",
  },
  insufficient_balance: {
    status: 402,
    message: "Your balance is too low to escrow this task.",
    fix: "Ask your user to top up at {top_up_url}, or lower bounty_usd to {max_affordable_bounty_usd} or less.",
  },
  bounty_exceeds_max: {
    status: 403,
    message: "bounty_usd is above this API key's max_bounty limit.",
    fix: "Lower bounty_usd to {max_bounty_usd} or less, or ask your user to raise the limit.",
  },
  daily_cap_exceeded: {
    status: 403,
    message: "This task would exceed the API key's daily spend cap.",
    fix: "You have {remaining_today_usd} USD left today. Lower bounty_usd, wait until tomorrow (UTC), or ask your user to raise daily_cap.",
  },
  task_type_not_allowed: {
    status: 403,
    message: "This API key is not allowed to post this task_type.",
    fix: "Use one of {allowed_task_types}, or ask your user to allow {task_type} for this key.",
  },
  unsafe_task: {
    status: 422,
    message:
      "Eyes only checks public, commercial or civic places, and never targets private people or homes.",
    fix: "Rephrase the task about a public place (store, cafe, park, transit stop, venue). Do not ask about specific people, homes, vehicles or private property.",
  },
  location_not_found: {
    status: 422,
    message: "Could not resolve that location.",
    fix: 'Pass the coordinates as numbers, e.g. {"lat": 37.7955, "lng": -122.3937}; coordinates always resolve. Or pass "place name, city", e.g. "Ferry Building, San Francisco".',
  },
  no_workers_nearby: {
    status: 409,
    message: "No available workers are near that location right now. Nothing was charged.",
    fix: "Call quote_task to check coverage, try a nearby busier location, or try again later.",
  },
  task_not_found: {
    status: 404,
    message: "No task with that task_id belongs to this API key.",
    fix: "Use the task_id returned by ask_eyes. Tasks from other API keys are not visible.",
  },
  task_not_cancellable: {
    status: 409,
    message: "Only unclaimed (dispatched) tasks can be cancelled.",
    fix: "A worker is already on it. Call await_answer to get the result, or dispute_answer if the answer is wrong.",
  },
  task_not_disputable: {
    status: 409,
    message: "Only answered tasks (verified, paid or needs_review) can be disputed.",
    fix: "Call get_task to see the current status. Unanswered tasks can be cancelled instead.",
  },
  idempotency_conflict: {
    status: 409,
    message: "This idempotency_key was already used with different parameters.",
    fix: "Reuse an idempotency_key only for an identical retry. Use a new key for a new question.",
  },
  offer_invalid: {
    status: 404,
    message: "This task link is invalid or has expired.",
    fix: "Open the newest link Eyes texted you. Expired tasks cannot be submitted.",
  },
  task_already_claimed: {
    status: 409,
    message: "Another worker already claimed this task.",
    fix: "No action needed. Watch for the next task text.",
  },
  rate_limited: {
    status: 429,
    message: "Too many requests.",
    fix: "Wait {retry_after_s} seconds and retry with the same idempotency_key.",
  },
  owner_link_invalid: {
    status: 404,
    message: "This owner control link is invalid.",
    fix: "Open the newest owner link from your signup email, or ask the Eyes operator for a fresh one.",
  },
  not_implemented: {
    status: 501,
    message: "This capability is not available yet.",
    fix: "Check /llms.txt for the currently supported tools.",
  },
  internal_error: {
    status: 500,
    message: "Something went wrong on our side.",
    fix: "Retry the same call. If you passed an idempotency_key, reuse it; retries are safe. If it keeps failing on a task, call get_task to check its state.",
  },
} as const satisfies Record<string, { status: number; message: string; fix: string }>;

export type ErrorCode = keyof typeof ERRORS;

export type ErrorBody = { error: ErrorCode; message: string; fix: string } & Record<string, unknown>;

export class EyesError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly context: Record<string, unknown>;
  readonly fix: string;

  constructor(
    code: ErrorCode,
    context: Record<string, unknown> = {},
    overrides: { message?: string; fix?: string } = {},
  ) {
    super(overrides.message ?? ERRORS[code].message);
    this.name = "EyesError";
    this.code = code;
    this.status = ERRORS[code].status;
    this.context = context;
    this.fix = renderFix(overrides.fix ?? ERRORS[code].fix, context);
  }

  toBody(): ErrorBody {
    return { ...this.context, error: this.code, message: this.message, fix: this.fix };
  }
}

function renderFix(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = context[key];
    if (value === undefined || value === null) return `<${key}>`;
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
}

export function toErrorBody(err: unknown): ErrorBody {
  return err instanceof EyesError ? err.toBody() : new EyesError("internal_error").toBody();
}
