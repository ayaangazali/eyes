import type { JoinWorkerOutput } from "@eyes/core";
import { $, call, LOCATION_HELP, Problem, showError } from "./api.ts";

const form = $<HTMLFormElement>("join");
const error = $("error");
const inkboxNumber = import.meta.env.VITE_INKBOX_NUMBER;
const connectCommand = import.meta.env.VITE_INKBOX_CONNECT;
let spot: { lat: number; lng: number } | null = null;

form.hidden = !inkboxNumber;
$("closed").hidden = Boolean(inkboxNumber);

export function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const e164 = input.trim().startsWith("+") ? `+${digits}` : `+1${digits.replace(/^1(?=\d{10}$)/, "")}`;
  return /^\+(1[2-9]\d\d[2-9]\d{6}|[2-9]\d{6,14})$/.test(e164) ? e164 : null;
}

function invalid(id: string, problem: Problem) {
  const field = $(id);
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", "error");
  field.focus();
  showError(error, problem);
}

$("locate").addEventListener("click", () => {
  error.hidden = true;
  $("where").textContent = "Finding you...";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      spot = { lat: coords.latitude, lng: coords.longitude };
      $("where").textContent = `Location set (within ${Math.round(coords.accuracy)} m).`;
    },
    (err) => {
      $("where").textContent = "";
      $("locate").textContent = "Try location again";
      showError(
        error,
        new Problem(
          "We could not get your location.",
          err.code === err.PERMISSION_DENIED
            ? LOCATION_HELP
            : "Move near a window or step outside, then tap Try location again.",
        ),
      );
    },
    { enableHighAccuracy: true, timeout: 15_000 },
  );
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  for (const field of form.querySelectorAll("[aria-invalid]")) {
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
  }
  const data = new FormData(form);
  const name = String(data.get("name")).trim();
  const phone = toE164(String(data.get("phone")));
  if (name.length < 2) {
    return invalid("name", new Problem("Please enter your name.", "Use at least 2 letters."));
  }
  if (!phone) {
    return invalid(
      "phone",
      new Problem(
        "That phone number does not look right.",
        "Enter a US mobile number like (415) 555-0123, or start with + and your country code.",
      ),
    );
  }
  if (!spot) {
    return invalid(
      "locate",
      new Problem(
        "We need your location to send you nearby tasks.",
        "Tap the location button and allow access.",
      ),
    );
  }
  const submit = $<HTMLButtonElement>("submit");
  submit.disabled = true;
  try {
    const out = await call<JoinWorkerOutput>("/w/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, phone, ...spot }),
    });
    const number = out.inkbox_number || inkboxNumber;
    const textLink = (body: string, label: string) =>
      Object.assign(document.createElement("a"), {
        href: `sms:${number}?&body=${encodeURIComponent(body)}`,
        className: "ui-button ui-button--primary ui-button--block",
        textContent: label,
      });
    ($("start").firstElementChild as HTMLElement).prepend(
      ...(connectCommand
        ? [
            textLink(connectCommand, `First text "${connectCommand}" to ${number}`),
            textLink("START", `Then text START to ${number}`),
          ]
        : [textLink("START", `Text START to ${number}`)]),
    );
    $("start").hidden = false;
    form.hidden = true;
    $("done").hidden = false;
  } catch (err) {
    showError(error, err);
  } finally {
    submit.disabled = false;
  }
});
