import { FAKE_PLACES } from "@eyes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNominatimGeo } from "./geo.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createNominatimGeo", () => {
  it("resolves demo places and coordinates without calling Nominatim", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const geo = createNominatimGeo();
    expect(await geo.geocode("  Ferry Building, San Francisco ")).toEqual(
      FAKE_PLACES["ferry building, san francisco"],
    );
    expect(await geo.geocode("37.7825, -122.4078")).toEqual({
      lat: 37.7825,
      lng: -122.4078,
      label: "37.7825, -122.4078",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps the first Nominatim hit, caches it, and returns null when nothing matches", async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        url.includes("Nowhere") || url.includes("95.5")
          ? []
          : [{ lat: "40.7527", lon: "-73.9772", display_name: "Grand Central Terminal, New York" }],
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const geo = createNominatimGeo();
    const place = { lat: 40.7527, lng: -73.9772, label: "Grand Central Terminal, New York" };
    expect(await geo.geocode("Grand Central, New York")).toEqual(place);
    expect(await geo.geocode("grand central, new york")).toEqual(place);
    expect(await geo.geocode("Nowhere Land")).toBeNull();
    expect(await geo.geocode("95.5, 200.1")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=Grand%20Central%2C%20New%20York",
    );
  });

  it("only trusts a hit that has the house number, retrying once with the street address", async () => {
    const hits: Record<string, string> = {
      "Philz Coffee, 3101 24th St, San Francisco": "Philz Coffee, 4298, 24th Street, Noe Valley, 94114",
      "3101 24th St, San Francisco": "La Rancho Market, 3101, 24th Street, Mission, 94110",
      "Philz Coffee, 4298 24th St, San Francisco": "Philz Coffee, 4298, 24th Street, Noe Valley, 94114",
      "Philz Coffee, 9999 24th St, San Francisco": "Philz Coffee, 4298, 24th Street, Noe Valley, 94114",
      "9999 24th St, San Francisco": "24th Street, Mission, 94110",
    };
    const fetch = vi.fn(async (url: string) => {
      const label = hits[new URL(url).searchParams.get("q") ?? ""];
      return Response.json(label ? [{ lat: "37.75", lon: "-122.41", display_name: label }] : []);
    });
    vi.stubGlobal("fetch", fetch);
    const geo = createNominatimGeo();
    const at = (label: string) => ({ lat: 37.75, lng: -122.41, label });
    expect(await geo.geocode("Philz Coffee, 3101 24th St, San Francisco")).toEqual(
      at("La Rancho Market, 3101, 24th Street, Mission, 94110"),
    );
    expect(await geo.geocode("Philz Coffee, 4298 24th St, San Francisco")).toEqual(
      at("Philz Coffee, 4298, 24th Street, Noe Valley, 94114"),
    );
    expect(await geo.geocode("Philz Coffee, 9999 24th St, San Francisco")).toBeNull();
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("q"))).toEqual([
      "Philz Coffee, 3101 24th St, San Francisco",
      "3101 24th St, San Francisco",
      "Philz Coffee, 4298 24th St, San Francisco",
      "Philz Coffee, 9999 24th St, San Francisco",
      "9999 24th St, San Francisco",
    ]);
  });
});
