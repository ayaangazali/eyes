import { FAKE_PLACES, type Geo } from "@eyes/core";

type Place = { lat: number; lng: number; label: string };

const NOMINATIM = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=";
// Nominatim policy: an identifying User-Agent and at most 1 request/s across the whole app.
const USER_AGENT = "Eyes/1.0 (+https://eyes.pictures; ops contact via repo)";
const GAP_MS = 1100;
const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const HOUSE = /^\s*(\d+)\s+\S/;

async function search(query: string): Promise<Place | null> {
  const res = await fetch(NOMINATIM + encodeURIComponent(query.trim()), {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status}`);
  const [hit] = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name } : null;
}

export function createNominatimGeo(): Geo {
  const cache = new Map<string, Place | null>();
  // ponytail: per-process throttle (main.ts builds one geo); a shared limiter if the container scales out.
  let nextSlot = 0;
  const throttled = async (query: string) => {
    const wait = nextSlot - Date.now();
    nextSlot = Math.max(Date.now(), nextSlot) + GAP_MS;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return search(query);
  };
  return {
    async geocode(query) {
      const key = query.trim().toLowerCase();
      const known = FAKE_PLACES[key];
      if (known) return known;
      const coords = COORDS.exec(query);
      const lat = Number(coords?.[1]);
      const lng = Number(coords?.[2]);
      if (coords && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, label: query.trim() };
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const parts = query.split(",");
      const at = parts.findIndex((part) => HOUSE.test(part));
      const house = HOUSE.exec(parts[at] ?? "")?.[1];
      const trusted = (place: Place | null) =>
        !house || place?.label.split(/[\s,;-]+/).includes(house) ? place : null;
      let place = trusted(await throttled(query));
      if (!place && at > 0 && at < parts.length - 1) {
        place = trusted(await throttled(parts.slice(at).join(",")));
      }
      cache.set(key, place);
      return place;
    },
  };
}
