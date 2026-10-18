import type { WorkerSetup } from "@eyes/core";
import { Problem } from "./api.ts";

export type Send = (path: string, init: RequestInit) => Promise<unknown>;

/** The Email row on /me: the optional second channel, so it never counts toward "Finish setting up". */
export type EmailRow = {
  status: WorkerSetup["email_status"];
  title: string;
  detail: string;
  removable: boolean;
  skipped: boolean;
};

export const validEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);

const post = (body: unknown, code?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(code && { Authorization: `Bearer ${code}` }) },
  body: JSON.stringify(body),
});

/** Every email error body carries a message and fix written for the worker; prefer them over the generic words. */
function worded(err: unknown): unknown {
  if (!(err instanceof Problem) || !err.body?.message) return err;
  return new Problem(err.body.message, err.body.fix ?? err.fix, err.status, err.body);
}

/** True when the API serves worker email: an empty sign-in request answers 400 there and 404 before. */
export async function emailOn(send: Send): Promise<boolean> {
  try {
    await send("/w/login/email", post({}));
    return true;
  } catch (err) {
    return err instanceof Problem && err.status !== 0 && err.status !== 404;
  }
}

const instruction =
  "Reply EMAIL in your existing Eyes iMessage conversation. We’ll reply with a link to send your first email.";

export function emailRow(s: WorkerSetup): EmailRow | null {
  const masked = s.email_masked ?? "your email";
  if (s.email_skipped && s.email_status !== "verified") {
    return {
      status: s.email_status,
      title: "Email optional — skipped",
      detail: instruction,
      removable: s.email_status === "pending",
      skipped: true,
    };
  }
  // An API that predates worker email sends neither field: show no row.
  switch (s.email_status) {
    case "none":
      return {
        status: "none",
        title: "Get tasks by email too",
        detail: instruction,
        removable: false,
        skipped: false,
      };
    case "pending":
      return {
        status: "pending",
        title: "Finish adding your email",
        detail: instruction,
        removable: true,
        skipped: false,
      };
    case "verified":
      return {
        status: "verified",
        title: "Email on",
        detail: `Tasks also go to ${masked}. ${instruction}`,
        removable: true,
        skipped: false,
      };
    default:
      return null;
  }
}

/** Removes the optional email channel without changing texts. */
export async function removeEmail(code: string, send: Send): Promise<WorkerSetup> {
  try {
    return (await send("/w/me/email", post({ email: null }, code))) as WorkerSetup;
  } catch (err) {
    throw worded(err);
  }
}

/** Records the worker's choice to use iMessage only; does not connect an email or send mail. */
export async function skipEmail(code: string, send: Send): Promise<WorkerSetup> {
  try {
    return (await send("/w/me/email/skip", post({}, code))) as WorkerSetup;
  } catch (err) {
    throw worded(err);
  }
}

/** Asks for a sign-in link. The API answers 200 whether or not the email is on an account. */
export async function sendLink(email: string, send: Send): Promise<void> {
  try {
    await send("/w/login/email", post({ email }));
  } catch (err) {
    throw worded(err);
  }
}

/** Trades the one-time code from an emailed link for the worker's /me code, then opens /me with it. */
export async function signIn(
  code: string,
  d: { send: Send; navigate: (url: string) => void },
): Promise<void> {
  const { token } = (await d.send("/w/login/code", post({ code }))) as { token: string };
  d.navigate(`me.html#c=${token}`);
}
