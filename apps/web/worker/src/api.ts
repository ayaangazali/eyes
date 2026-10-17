import type { ErrorBody, ErrorCode } from "@eyes/core";

declare global {
  interface ImportMetaEnv {
    readonly VITE_EYES_API_URL?: string;
    readonly VITE_INKBOX_NUMBER?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

const TRY_AGAIN = "Wait a moment, then try again.";
const WORDS: Partial<Record<ErrorCode, [string, string]>> = {
  offer_invalid: ["This task link is invalid or has expired.", "Open the newest link Eyes texted you."],
  task_already_claimed: [
    "Another worker already claimed this task.",
    "No action needed. Watch for the next task text.",
  ],
  invalid_input: ["Eyes could not accept that.", "Check what you entered, then try again."],
  internal_error: ["Something went wrong at Eyes.", TRY_AGAIN],
};

export class Problem extends Error {
  fix: string;
  status: number;
  body: Partial<ErrorBody> | null;
  constructor(message: string, fix: string, status = 0, body: Partial<ErrorBody> | null = null) {
    super(message);
    this.fix = fix;
    this.status = status;
    this.body = body;
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${import.meta.env.VITE_EYES_API_URL ?? ""}${path}`, init).catch(() => {
    throw new Problem("Could not reach Eyes.", "Check your signal, then try again.");
  });
  const body: Partial<ErrorBody> | null = await res.json().catch(() => null);
  if (res.ok) return body as T;
  const [message, fix] = (body?.error && WORDS[body.error]) || [
    `Eyes had a problem (HTTP ${res.status}).`,
    TRY_AGAIN,
  ];
  throw new Problem(message, fix, res.status, body);
}

export function showError(el: HTMLElement, err: unknown) {
  const { message, fix } =
    err instanceof Problem ? err : { message: String(err), fix: "Reload the page and try again." };
  const strong = document.createElement("strong");
  strong.textContent = message;
  el.replaceChildren(strong, document.createElement("br"), fix);
  el.hidden = false;
}
