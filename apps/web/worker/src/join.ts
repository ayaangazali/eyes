import type { JoinWorkerOutput } from "@eyes/core";
import { toE164 } from "@eyes/core/phone";
import { $, call, LOCATION_HELP, Problem, showError } from "./api.ts";

const form = $<HTMLFormElement>("join");
const error = $("error");
const inkboxNumber = import.meta.env.VITE_INKBOX_NUMBER;
const connectCommand = import.meta.env.VITE_INKBOX_CONNECT;
let spot: { lat: number; lng: number } | null = null;

form.hidden = !inkboxNumber;
$("closed").hidden = Boolean(inkboxNumber);

function invalid(id: string, problem: Problem) {
  const field = $(id);
  field.setAttribute("aria-invalid", "true");
  field.setAttribute("aria-describedby", "error");
  field.focus();
  showError(error, problem);
}

$("locate").addEventListener("click", () => {
  const locate = $("locate");
  error.hidden = true;
  locate.removeAttribute("data-settled");
  locate.setAttribute("aria-busy", "true");
  $("where").textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      spot = { lat: coords.latitude, lng: coords.longitude };
      locate.removeAttribute("aria-busy");
      locate.setAttribute("data-settled", "");
      $("locate-label").textContent = "Location set";
      $("where").textContent = `Accurate to ${Math.round(coords.accuracy)} m. Tap again to update it.`;
    },
    (err) => {
      locate.removeAttribute("aria-busy");
      $("where").textContent = "";
      $("locate-label").textContent = "Try location again";
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
    const displayNumber = String(number).replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 ($1) $2-$3");
    ($("start").firstElementChild as HTMLElement).prepend(
      Object.assign(document.createElement("span"), { textContent: "Click below to connect" }),
      Object.assign(document.createElement("a"), {
        href: `sms:${number}?&body=${encodeURIComponent(connectCommand || "START")}`,
        className: "ui-button ui-button--primary ui-button--block",
        textContent: connectCommand ? `Text ${connectCommand}` : "Text START",
      }),
      Object.assign(document.createElement("span"), { textContent: `To ${displayNumber}` }),
    );
    $("start").hidden = false;
    $("start-contact").hidden = !connectCommand;
    form.hidden = true;
    $("done").hidden = false;
    $("done-heading").focus();
    $("join-status").textContent =
      "You have joined Eyes. Follow the steps below to text START and receive tasks.";
  } catch (err) {
    showError(error, err);
    error.focus();
  } finally {
    submit.disabled = false;
  }
});
