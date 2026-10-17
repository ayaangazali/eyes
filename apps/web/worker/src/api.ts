import type { ErrorBody } from "@eyes/core";

declare global {
  interface ImportMetaEnv {
    readonly VITE_EYES_API_URL: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export class Problem extends Error {
  fix: string;
  constructor(message: string, fix: string) {
    super(message);
    this.fix = fix;
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${import.meta.env.VITE_EYES_API_URL}${path}`, init).catch(() => {
    throw new Problem("Could not reach Eyes.", "Check your signal and try again.");
  });
  const body: Partial<ErrorBody> | null = await res.json().catch(() => null);
  if (res.ok) return body as T;
  if (body?.message && body.fix) throw new Problem(body.message, body.fix);
  throw new Problem(`Eyes had a problem (HTTP ${res.status}).`, "Try again in a minute.");
}

export function showError(el: HTMLElement, err: unknown) {
  const { message, fix } =
    err instanceof Problem ? err : { message: String(err), fix: "Reload the page and try again." };
  const strong = document.createElement("strong");
  strong.textContent = message;
  el.replaceChildren(strong, document.createElement("br"), fix);
  el.hidden = false;
}
