import { FAKE_PLACES } from "@eyes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNominatimGeo } from "./geo.ts";

afterEach(() => {
  vi.useRealTimers();
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

  const nominatim = (hits: Record<string, string>) =>
    vi.fn(async (url: string) => {
      const label = hits[new URL(url).searchParams.get("q") ?? ""];
      return Response.json(label ? [{ lat: "37.75", lon: "-122.41", display_name: label }] : []);
    });
  const queries = (fetch: ReturnType<typeof nominatim>) =>
    fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("q"));
  const at = (label: string) => ({ lat: 37.75, lng: -122.41, label });

  it("only trusts a hit that has the house number, retrying once 1.1 s later with the street address", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetch = nominatim({
      "Philz Coffee, 3101 24th St, San Francisco": "Philz Coffee, 4298, 24th Street, Noe Valley, 94114",
      "3101 24th St, San Francisco": "La Rancho Market, 3101, 24th Street, Mission, 94110",
      "Philz Coffee, 4298 24th St, San Francisco": "Philz Coffee, 4298, 24th Street, Noe Valley, 94114",
      "Philz Coffee, 9999 24th St, San Francisco": "Philz Coffee, 4298, 24th Street, Noe Valley, 94114",
      "9999 24th St, San Francisco": "24th Street, Mission, 94110",
    });
    vi.stubGlobal("fetch", fetch);
    const geo = createNominatimGeo();
    const philz = geo.geocode("Philz Coffee, 3101 24th St, San Francisco");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await philz).toEqual(at("La Rancho Market, 3101, 24th Street, Mission, 94110"));
    expect(await geo.geocode("Philz Coffee, 4298 24th St, San Francisco")).toEqual(
      at("Philz Coffee, 4298, 24th Street, Noe Valley, 94114"),
    );
    const missing = geo.geocode("Philz Coffee, 9999 24th St, San Francisco");
    await vi.advanceTimersByTimeAsync(1100);
    expect(await missing).toBeNull();
    expect(queries(fetch)).toEqual([
      "Philz Coffee, 3101 24th St, San Francisco",
      "3101 24th St, San Francisco",
      "Philz Coffee, 4298 24th St, San Francisco",
      "Philz Coffee, 9999 24th St, San Francisco",
      "9999 24th St, San Francisco",
    ]);
  });

  it("retries from the part with the house number, and not when the query starts with it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetch = nominatim({
      "Philz Coffee, Mission, 3101 24th St, San Francisco": "Philz Coffee, 4298, 24th Street, 94114",
      "3101 24th St, San Francisco": "La Rancho Market, 3101, 24th Street, Mission, 94110",
      "548 Market St, Suite 200, San Francisco": "Market Street, Financial District, 94104",
    });
    vi.stubGlobal("fetch", fetch);
    const geo = createNominatimGeo();
    const philz = geo.geocode("Philz Coffee, Mission, 3101 24th St, San Francisco");
    await vi.advanceTimersByTimeAsync(1100);
    expect(await philz).toEqual(at("La Rancho Market, 3101, 24th Street, Mission, 94110"));
    expect(await geo.geocode("548 Market St, Suite 200, San Francisco")).toBeNull();
    expect(queries(fetch)).toEqual([
      "Philz Coffee, Mission, 3101 24th St, San Francisco",
      "3101 24th St, San Francisco",
      "548 Market St, Suite 200, San Francisco",
    ]);
  });

  it("reads the house number only at the start of a part and finds it in multi-number labels", async () => {
    const fetch = nominatim({
      "135 Powell St, San Francisco": "Walgreens, 135;141;149, Powell Street, Union Square, 94102",
      "Suite 200, 548 Market St, San Francisco": "548, Market Street, Financial District, 94104",
      "Blue Bottle Coffee, San Francisco, CA 94103": "Blue Bottle Coffee, Mint Plaza, San Francisco",
    });
    vi.stubGlobal("fetch", fetch);
    const geo = createNominatimGeo();
    expect(await geo.geocode("135 Powell St, San Francisco")).toEqual(
      at("Walgreens, 135;141;149, Powell Street, Union Square, 94102"),
    );
    expect(await geo.geocode("Suite 200, 548 Market St, San Francisco")).toEqual(
      at("548, Market Street, Financial District, 94104"),
    );
    expect(await geo.geocode("Blue Bottle Coffee, San Francisco, CA 94103")).toEqual(
      at("Blue Bottle Coffee, Mint Plaza, San Francisco"),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
