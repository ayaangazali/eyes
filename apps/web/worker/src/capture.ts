import type { CaptureResult, OfferView, TaskStatus, TaskType } from "@eyes/core";
import { $, call, LOCATION_HELP, Problem, showError } from "./api.ts";

const ALREADY_SENT = "A photo was already sent for this task. Nothing else to do.";
const CLOSED: Record<TaskStatus, string> = {
  dispatched: "Reply YES to the Eyes text to claim this task, then open this link again.",
  claimed: "Another worker already claimed this task. Watch for the next task text.",
  submitted: ALREADY_SENT,
  verified: ALREADY_SENT,
  paid: ALREADY_SENT,
  needs_review: ALREADY_SENT,
  disputed: ALREADY_SENT,
  expired: "This task expired. Watch for the next task text.",
  refunded: "This task was cancelled. Watch for the next task text.",
};
const OUTCOME: Partial<Record<TaskStatus, string>> = {
  paid: "Verified and paid",
  verified: "Verified, payout pending",
  needs_review: "Sent, needs a quick review",
};
const YES_NO: TaskType[] = ["is_open", "in_stock"];
const GPS_GOOD_M = 50;
const GPS_WAIT_MS = 15_000;

const token = new URLSearchParams(location.search).get("t") ?? "";
const error = $("error");
const form = $<HTMLFormElement>("capture");
const video = $<HTMLVideoElement>("video");
const shutter = $<HTMLButtonElement>("shutter");
const send = $<HTMLButtonElement>("send");

let offer: OfferView;
let photo: File | null = null;
let capturedAt = "";
let here: GeolocationCoordinates | null = null;
let searching = false;
let sending = false;
let closed = false;
let watch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;

function meters(a: GeolocationCoordinates, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.latitude) * rad) / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.longitude) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function ready() {
  shutter.disabled = closed || video.readyState < video.HAVE_CURRENT_DATA;
  const todo = sending
    ? "Sending..."
    : offer.require_photo && !photo
      ? "Take the photo first."
      : searching
        ? "Waiting for GPS..."
        : here
          ? ""
          : "Your location is needed to send.";
  send.disabled = closed || todo !== "";
  $("todo").textContent = todo;
}

function showGps() {
  const fix = here
    ? `GPS within ${Math.round(here.accuracy)} m. You are ${Math.round(meters(here, offer))} m from the place.`
    : "";
  $("gps").textContent = searching ? `${fix} Getting your location...`.trim() : fix;
}

function stopGps() {
  navigator.geolocation.clearWatch(watch);
  clearTimeout(timer);
  searching = false;
}

function finish() {
  closed = true;
  clearInterval(ticker);
  $("deadline").hidden = true;
  $("relocate").hidden = true;
  stopGps();
  for (const track of (video.srcObject as MediaStream | null)?.getTracks() ?? []) track.stop();
  form.hidden = true;
  ready();
}

function close(reason: string) {
  finish();
  $("closed").textContent = reason;
  $("closed").hidden = false;
}

function tick() {
  const s = Math.max(0, Math.floor((Date.parse(offer.deadline_at) - Date.now()) / 1000));
  $("deadline").textContent =
    s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left` : "Deadline passed";
  if (s === 0 && !closed && !sending) close(CLOSED.expired);
}

function locate() {
  stopGps();
  error.hidden = true;
  $("relocate").hidden = true;
  searching = true;
  const previous = here;
  let best: GeolocationCoordinates | null = null;
  const end = (denied: boolean) => {
    stopGps();
    if (!here) {
      showError(
        error,
        new Problem(
          "We could not get your location.",
          denied ? LOCATION_HELP : "Move near a window or step outside, then tap Try location again.",
        ),
      );
      $("relocate").hidden = false;
    }
    showGps();
    ready();
  };
  timer = setTimeout(() => end(false), GPS_WAIT_MS);
  watch = navigator.geolocation.watchPosition(
    ({ coords }) => {
      if (best && best.accuracy <= coords.accuracy) return;
      best = coords;
      if (!previous || coords.accuracy <= Math.max(previous.accuracy, GPS_GOOD_M)) here = coords;
      if (coords.accuracy <= GPS_GOOD_M) return end(false);
      showGps();
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) end(true);
    },
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  showGps();
  ready();
}

async function startCamera() {
  const stream = await navigator.mediaDevices
    ?.getUserMedia({ video: { facingMode: "environment" } })
    .catch((err: Error) => {
      if (err.name === "NotAllowedError") {
        $("why").textContent =
          "Camera access is blocked for this page, so the live view cannot open. Tap Take the photo to use your phone's camera instead, and take it now, not from your gallery.";
      }
      return null;
    });
  if (!stream) {
    $("fallback").hidden = false;
    return;
  }
  video.srcObject = stream;
  $("live").hidden = false;
}

function usePhoto(file: File, at: string) {
  photo = file;
  capturedAt = at;
  const preview = $<HTMLImageElement>("preview");
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  video.hidden = true;
  shutter.textContent = "Retake photo";
  shutter.className = "secondary";
  locate();
}

function showResult({ status, message, verification: v }: CaptureResult) {
  finish();
  $("outcome").textContent = OUTCOME[status] ?? "Sent";
  $("message").textContent = message;
  const checks = [
    ["Location matches the place", v.gps_ok],
    ["Photo taken in time", v.fresh_ok],
    ["Photo answers the question", v.vision_ok],
  ] as const;
  $("checks").replaceChildren(
    ...checks.map(([label, ok]) => {
      const li = document.createElement("li");
      li.className = ok ? "ok" : "fail";
      li.textContent = `${label}: ${ok ? "passed" : "failed"}`;
      return li;
    }),
  );
  $("reason").textContent = v.vision_reason;
  $("result").hidden = false;
}

video.addEventListener("loadeddata", ready);

shutter.addEventListener("click", () => {
  if (video.hidden) {
    photo = null;
    video.hidden = false;
    $("preview").hidden = true;
    shutter.textContent = "Take photo";
    shutter.className = "";
    return ready();
  }
  const at = new Date().toISOString();
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")?.drawImage(video, 0, 0);
  canvas.toBlob(
    (blob) => {
      if (blob) usePhoto(new File([blob], "capture.jpg", { type: "image/jpeg" }), at);
    },
    "image/jpeg",
    0.85,
  );
});

$("relocate").addEventListener("click", locate);

$<HTMLInputElement>("file").addEventListener("change", (event) => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (file) usePhoto(file, new Date(file.lastModified).toISOString());
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!here || send.disabled) return;
  error.hidden = true;
  const data = new FormData(form);
  data.set("answer_bool", String(data.get("answer_bool") ?? ""));
  data.set("lat", String(here.latitude));
  data.set("lng", String(here.longitude));
  data.set("accuracy_m", String(here.accuracy));
  data.set("captured_at", capturedAt || new Date().toISOString());
  if (photo) data.set("photo", photo);
  sending = true;
  ready();
  try {
    showResult(
      await call<CaptureResult>(`/w/offers/${encodeURIComponent(token)}/capture`, {
        method: "POST",
        body: data,
      }),
    );
  } catch (err) {
    sending = false;
    const sentBefore =
      err instanceof Problem && err.status === 404 && CLOSED[err.body?.status as TaskStatus] === ALREADY_SENT;
    if (sentBefore) return close(ALREADY_SENT);
    showError(error, err);
    if (err instanceof Problem && (err.status === 404 || err.status === 409)) finish();
    else ready();
  }
});

async function main() {
  if (!token)
    throw new Problem("This task link is incomplete.", "Open the full link from the newest Eyes text.");
  offer = await call<OfferView>(`/w/offers/${encodeURIComponent(token)}`);
  $("question").textContent = offer.question;
  $("bounty").textContent = `$${offer.bounty_usd.toFixed(2)} for this task`;
  $("place").replaceChildren(
    Object.assign(document.createElement("a"), {
      href: `https://www.google.com/maps/search/?api=1&query=${offer.lat},${offer.lng}`,
      target: "_blank",
      rel: "noopener",
      textContent: `${offer.place_label} (map)`,
    }),
  );
  const lost = !offer.claimed_by_you && CLOSED[offer.status] === ALREADY_SENT;
  if (offer.status !== "claimed" || !offer.claimed_by_you)
    close(lost ? CLOSED.claimed : CLOSED[offer.status]);
  tick();
  if (closed) return;
  ticker = setInterval(tick, 1000);
  $("yesno").hidden = !YES_NO.includes(offer.task_type);
  form.hidden = false;
  locate();
  await startCamera();
}

main().catch((err) => {
  $("question").textContent = "We could not open this task";
  showError(error, err);
});
