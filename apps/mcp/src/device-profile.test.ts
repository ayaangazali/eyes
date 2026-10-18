import { describe, expect, it } from "vitest";
import { deviceProfile, parseDeviceAttributes } from "./device-profile.ts";

const plist = (body: string) =>
  new TextEncoder().encode(`\u0030\u0082junk<?xml version="1.0"?><plist><dict>${body}</dict></plist>junk`);

describe("deviceProfile", () => {
  it("is a Profile Service payload asking for UDID, with the callback URL escaped", () => {
    const xml = deviceProfile("https://api.eyes.test/w/device/a.b?x=1&y=<2");
    expect(xml).toContain("<string>https://api.eyes.test/w/device/a.b?x=1&amp;y=&lt;2</string>");
    expect(xml).toContain("<string>UDID</string>");
    expect(xml).toContain("<string>Profile Service</string>");
    expect(deviceProfile("u")).not.toBe(deviceProfile("u")); // fresh PayloadUUID
  });
});

describe("parseDeviceAttributes", () => {
  it("reads UDID, PRODUCT and VERSION from the signed plist", () => {
    expect(
      parseDeviceAttributes(
        plist(
          "<key>PRODUCT</key><string>iPhone18,1</string><key>UDID</key><string> 00008110-001A2B3C4D5E801E </string><key>VERSION</key><string>23F79</string>",
        ),
      ),
    ).toEqual({ udid: "00008110-001A2B3C4D5E801E", product: "iPhone18,1", version: "23F79" });
  });

  it("missing PRODUCT/VERSION are null; a missing or malformed UDID is rejected", () => {
    expect(
      parseDeviceAttributes(
        plist("<key>UDID</key><string>0123456789abcdef0123456789abcdef01234567</string>"),
      ),
    ).toEqual({
      udid: "0123456789abcdef0123456789abcdef01234567",
      product: null,
      version: null,
    });
    expect(parseDeviceAttributes(plist("<key>UDID</key><string>../../etc</string>"))).toBeNull();
    expect(parseDeviceAttributes(plist("<key>PRODUCT</key><string>iPhone</string>"))).toBeNull();
    expect(parseDeviceAttributes(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
