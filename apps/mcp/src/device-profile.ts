// iOS Profile Service (ad hoc install, T6.31): the profile asks the iPhone for its device ID and
// posts it to `callbackUrl`. Unsigned, so iOS labels it "Unverified"; it installs nothing.
// ponytail: unsigned profile; sign it (CMS with a TLS cert) if "Unverified" scares workers off.
import { randomUUID } from "node:crypto";

export function deviceProfile(callbackUrl: string): string {
  const escaped = callbackUrl.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${escaped}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>PRODUCT</string>
      <string>VERSION</string>
    </array>
  </dict>
  <key>PayloadOrganization</key>
  <string>Eyes</string>
  <key>PayloadDisplayName</key>
  <string>Eyes: register this iPhone</string>
  <key>PayloadDescription</key>
  <string>Sends this iPhone's device ID to Eyes so you can install the Eyes app. Installs nothing.</string>
  <key>PayloadIdentifier</key>
  <string>pictures.eyes.device-registration</string>
  <key>PayloadUUID</key>
  <string>${randomUUID().toUpperCase()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>
`;
}

export type DeviceAttributes = { udid: string; product: string | null; version: string | null };

// The iPhone posts a CMS-signed plist; the plist sits in the signed data as plain XML.
export function parseDeviceAttributes(body: Uint8Array): DeviceAttributes | null {
  const text = Buffer.from(body).toString("latin1");
  const plist = /<\?xml[\s\S]*?<\/plist>/.exec(text)?.[0] ?? "";
  const value = (key: string) =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1]?.trim() || null;
  const udid = value("UDID");
  if (!udid || !/^[0-9A-Fa-f-]{25,40}$/.test(udid)) return null;
  return { udid, product: value("PRODUCT"), version: value("VERSION") };
}
