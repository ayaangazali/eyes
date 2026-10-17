import { FAKE_PLACES, type Geo } from "@eyes/core";

type Place = { lat: number; lng: number; label: string };

const NOMINATIM = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=";
const USER_AGENT = "eyes-mcp/0.1 (+https://github.com/ayaangazali/eyes)";
const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export function createNominatimGeo(): Geo {
  const cache = new Map<string, Place | null>();
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
      const res = await fetch(NOMINATIM + encodeURIComponent(query.trim()), {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status}`);
      const [hit] = (await res.json()) as { lat: string; lon: string; display_name: string }[];
      const place = hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name } : null;
      cache.set(key, place);
      return place;
    },
  };
}
