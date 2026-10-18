import { describe, expect, it } from "vitest";
import { parseMapLink } from "./util.ts";

const SPOT = { lat: 37.761, lng: -122.386 };

describe("parseMapLink", () => {
  it.each([
    "https://maps.apple.com/?ll=37.761,-122.386",
    "https://maps.apple.com/?address=1%20Main%20St&ll=37.761%2C-122.386&q=Dropped%20Pin",
    "https://maps.apple.com/?q=37.761,-122.386",
    "https://maps.apple.com/?q=Coffee&sll=37.761,-122.386",
    "maps.apple.com/place?coordinate=37.761,-122.386",
    "https://www.google.com/maps/@37.761,-122.386,15z",
    "https://www.google.com/maps?q=37.761,-122.386",
    "https://www.google.com/maps/place/Dolores+Park/@37.761,-122.386,17z/data=!3m1",
    "I'm here: 37.761, -122.386 by the gate",
    "37.761,-122.386",
    "Here you go https://maps.apple.com/?ll=37.761,-122.386.",
  ])("reads %s", (text) => {
    expect(parseMapLink(text)).toEqual(SPOT);
  });

  it.each([
    "",
    "\ufffc",
    "\ufffd",
    "YES",
    "I got 12, 34 of them",
    "https://maps.apple.com/?address=1%20Main%20St",
    "https://example.com/?ll=37.761,-122.386",
    "https://maps.apple.com/?ll=95.0,-122.386",
    "https://www.google.com/maps/@37.761,-190.5,15z",
    "0.0, 0.0",
    "https://maps.apple.com/?ll=0,0",
  ])("ignores %j", (text) => {
    expect(parseMapLink(text)).toBeNull();
  });

  it.each(["https://maps.app.goo.gl/AbCdEf123", "see goo.gl/maps/xyz"])("flags short link %s", (text) => {
    expect(parseMapLink(text)).toBe("short_link");
  });

  it("prefers coordinates over a short link in the same text", () => {
    expect(parseMapLink("https://maps.app.goo.gl/AbC or 37.761, -122.386")).toEqual(SPOT);
  });
});
