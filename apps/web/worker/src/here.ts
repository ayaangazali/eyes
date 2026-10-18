import { LOCATION_HELP, Problem } from "./api.ts";

export type HereElements = {
  button: HTMLButtonElement;
  done: HTMLElement;
  error: HTMLElement;
  ready: HTMLElement;
  missing: HTMLElement;
};

export type HereDeps = {
  token: string;
  geolocation: Pick<Geolocation, "getCurrentPosition"> | undefined;
  send: (path: string, init: RequestInit) => Promise<unknown>;
  report: (el: HTMLElement, err: unknown) => void;
};

export function currentPosition(
  geolocation: Pick<Geolocation, "getCurrentPosition">,
): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) =>
    geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20_000 }),
  );
}

// A denied permission and any other geolocation failure need different next steps.
export function locationProblem(err: GeolocationPositionError): Problem {
  return err.code === err.PERMISSION_DENIED
    ? new Problem("Location is blocked for this page.", LOCATION_HELP)
    : new Problem("Could not find your location.", "Step outside or near a window, then tap again.");
}

// The server's own words fit here better than the generic ones (expired link, too soon).
export function serverProblem(err: unknown): unknown {
  const body = err instanceof Problem ? err.body : null;
  return body?.message ? new Problem(body.message, body.fix ?? "") : err;
}

export function wireHere(els: HereElements, deps: HereDeps): void {
  // Without a code the update cannot work, so the page shows only the way to get a new link.
  if (!deps.token) {
    els.ready.hidden = true;
    els.missing.hidden = false;
    return;
  }
  els.button.addEventListener("click", async () => {
    els.button.disabled = true;
    els.done.hidden = true;
    els.error.hidden = true;
    try {
      if (!deps.geolocation) throw new Problem("This browser cannot share your location.", LOCATION_HELP);
      const pos = await currentPosition(deps.geolocation).catch((err: GeolocationPositionError) => {
        throw locationProblem(err);
      });
      const { latitude, longitude, accuracy } = pos.coords;
      await deps
        .send("/w/location", {
          method: "POST",
          headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: latitude,
            lng: longitude,
            accuracy_m: accuracy,
            source: "here_link",
            captured_at: new Date(pos.timestamp).toISOString(),
          }),
        })
        .catch((err: unknown) => {
          throw serverProblem(err);
        });
      els.done.textContent = `Spot updated. Near ${latitude.toFixed(3)}, ${longitude.toFixed(3)}. You can close this page.`;
      els.done.hidden = false;
    } catch (err) {
      deps.report(els.error, err);
    } finally {
      els.button.disabled = false;
    }
  });
}
