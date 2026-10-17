import type { CaptureResult, OfferView, TaskStatus, TaskType } from "@eyes/core";
import { $, call, Problem, showError } from "./api.ts";

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
let watch = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function meters(a: GeolocationCoordinates, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.latitude) * rad) / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.longitude) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function ready() {
  send.disabled = !here || (offer.require_photo && !photo);
}

function tick() {
  const s = Math.max(0, Math.floor((Date.parse(offer.deadline_at) - Date.now()) / 1000));
  $("deadline").textContent =
    s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left` : "Deadline passed";
}

function stopGps() {
  navigator.geolocation.clearWatch(watch);
  clearTimeout(timer);
}

function locate() {
  stopGps();
  here = null;
  ready();
  $("gps").textContent = "Getting your location...";
  const giveUp = () => {
    stopGps();
    if (!here) {
      showError(
        error,
        new Problem(
          "We could not get your location.",
          "Allow location access for this page, then reload it.",
        ),
      );
    }
  };
  timer = setTimeout(giveUp, GPS_WAIT_MS);
  watch = navigator.geolocation.watchPosition(
    ({ coords }) => {
      if (here && here.accuracy <= coords.accuracy) return;
      here = coords;
      $("gps").textContent =
        `GPS within ${Math.round(coords.accuracy)} m. You are ${Math.round(meters(coords, offer))} m from the place.`;
      ready();
      if (coords.accuracy <= GPS_GOOD_M) stopGps();
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) giveUp();
    },
    { enableHighAccuracy: true, maximumAge: 0 },
  );
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $("fallback").hidden = false;
    return;
  }
  video.srcObject = await navigator.mediaDevices
    .getUserMedia({ video: { facingMode: "environment" } })
    .catch(() => {
      throw new Problem(
        "Your camera is blocked.",
        "Allow camera access for this page in your browser settings, then reload it.",
      );
    });
  $("live").hidden = false;
}

function usePhoto(file: File, at: string) {
  photo = file;
  capturedAt = at;
  const preview = $<HTMLImageElement>("preview");
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  shutter.textContent = "Retake photo";
  locate();
}

function showResult({ message, verification: v }: CaptureResult) {
  stopGps();
  for (const track of (video.srcObject as MediaStream | null)?.getTracks() ?? []) track.stop();
  form.hidden = true;
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

video.addEventListener("loadeddata", () => {
  shutter.disabled = false;
});

shutter.addEventListener("click", () => {
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

$<HTMLInputElement>("file").addEventListener("change", (event) => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (file) usePhoto(file, new Date(file.lastModified).toISOString());
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!here) return;
  error.hidden = true;
  const data = new FormData(form);
  data.set("answer_bool", String(data.get("answer_bool") ?? ""));
  data.set("lat", String(here.latitude));
  data.set("lng", String(here.longitude));
  data.set("accuracy_m", String(here.accuracy));
  data.set("captured_at", capturedAt || new Date().toISOString());
  if (photo) data.set("photo", photo);
  send.disabled = true;
  try {
    showResult(
      await call<CaptureResult>(`/w/offers/${encodeURIComponent(token)}/capture`, {
        method: "POST",
        body: data,
      }),
    );
  } catch (err) {
    showError(error, err);
    send.disabled = false;
  }
});

async function main() {
  if (!token)
    throw new Problem("This task link is incomplete.", "Open the full link from the newest Eyes text.");
  offer = await call<OfferView>(`/w/offers/${encodeURIComponent(token)}`);
  $("question").textContent = offer.question;
  $("bounty").textContent = `$${offer.bounty_usd.toFixed(2)}`;
  $("place").replaceChildren(
    Object.assign(document.createElement("a"), {
      href: `https://www.google.com/maps/search/?api=1&query=${offer.lat},${offer.lng}`,
      target: "_blank",
      rel: "noopener",
      textContent: `${offer.place_label} (map)`,
    }),
  );
  tick();
  setInterval(tick, 1000);
  $("task").hidden = false;
  if (offer.status !== "claimed" || !offer.claimed_by_you) {
    $("closed").textContent = CLOSED[offer.status];
    $("closed").hidden = false;
    return;
  }
  $("yesno").hidden = !YES_NO.includes(offer.task_type);
  form.hidden = false;
  locate();
  await startCamera();
}

main().catch((err) => showError(error, err));
