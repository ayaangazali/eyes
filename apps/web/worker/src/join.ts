import type { JoinWorkerOutput } from "@eyes/core";
import { $, call, Problem, showError } from "./api.ts";

const form = $<HTMLFormElement>("join");
const error = $("error");
let spot: { lat: number; lng: number } | null = null;

function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  const us = digits.replace(/^1(?=\d{10}$)/, "");
  return /^[2-9]\d{9}$/.test(us) ? `+1${us}` : null;
}

$("locate").addEventListener("click", () => {
  error.hidden = true;
  $("where").textContent = "Finding you...";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      spot = { lat: coords.latitude, lng: coords.longitude };
      $("where").textContent = `Location set (within ${Math.round(coords.accuracy)} m).`;
    },
    () => {
      $("where").textContent = "";
      showError(
        error,
        new Problem(
          "We could not get your location.",
          "Allow location access for this page, then tap again.",
        ),
      );
    },
    { enableHighAccuracy: true, timeout: 15_000 },
  );
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const data = new FormData(form);
  const phone = toE164(String(data.get("phone")));
  if (!phone) {
    return showError(
      error,
      new Problem(
        "That phone number does not look right.",
        "Enter a US mobile number like (415) 555-0123, or start with + and your country code.",
      ),
    );
  }
  if (!spot) {
    return showError(
      error,
      new Problem("We need your location to send you nearby tasks.", "Tap Use my location and allow access."),
    );
  }
  const submit = $<HTMLButtonElement>("submit");
  submit.disabled = true;
  try {
    const out = await call<JoinWorkerOutput>("/w/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: String(data.get("name")).trim(), phone, ...spot }),
    });
    if (out.connect_url) {
      $("payouts").prepend(
        Object.assign(document.createElement("a"), {
          href: out.connect_url,
          className: "button secondary",
          target: "_blank",
          rel: "noopener",
          textContent: "Set up payouts",
        }),
      );
      $("payouts").hidden = false;
    }
    form.hidden = true;
    $("done").hidden = false;
  } catch (err) {
    showError(error, err);
  } finally {
    submit.disabled = false;
  }
});
