// Ad hoc release of the Eyes iOS app (apps/mobile) for workers not on TestFlight:
// registers new worker iPhones with Apple, builds and checks the .ipa, uploads it with its install manifest,
// then texts each worker whose iPhone the build now installs on.
// Usage: pnpm adhoc:release [--dry-run] [--repo <checkout>]   (reads .env from the current directory)
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs as parseCli } from "node:util";
import { createAdminClient } from "@insforge/sdk";
import { createInkboxMessaging } from "../packages/comms/src/index.ts";

const TEAM_ID = "2BPG8N4Z33";
const INSTALL_TEXT = "Eyes is ready: tap to install";
const NO_KEY =
  "Create an App Store Connect API key (App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys, Admin access), save it as ~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8, and set ASC_KEY_ID and ASC_ISSUER_ID in .env.";

export type Device = {
  udid: string;
  worker_id: string;
  apple_registered_at: string | null;
  released_at: string | null;
  workers: { phone: string; opted_in: boolean };
};

export type Deps = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  exec: (cmd: string, args: string[], cwd: string) => void;
  upload: (key: string, body: Blob) => Promise<string>;
  sendText: (to: string, text: string) => Promise<unknown>;
  now: () => Date;
};

const short = (udid: string) => `${udid.slice(0, 6)}…`;
/** Error text for public CI logs: UDIDs cut to 6 characters, phone numbers to their last 2 digits. */
export const mask = (text: string) =>
  text
    .replace(/\b([0-9A-Fa-f]{6})[0-9A-Fa-f-]{18,}\b/g, "$1…")
    .replace(/\+?\d[\d\s().-]{5,}(\d{2})\b/g, "…$1");
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const plist = (dict: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${dict}
</dict>
</plist>
`;

export function parseArgs(argv: string[]) {
  const { values } = parseCli({
    args: argv,
    options: { "dry-run": { type: "boolean", default: false }, repo: { type: "string", default: "." } },
  });
  return { dryRun: values["dry-run"], repo: resolve(values.repo) };
}

/** App Store Connect API token: ES256 JWT signed with the team key (.p8 = PKCS#8 PEM), valid 10 minutes. */
export function ascToken(p8: string, keyId: string, issuerId: string, now: Date): string {
  const part = (json: object) => Buffer.from(JSON.stringify(json)).toString("base64url");
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${part({ alg: "ES256", kid: keyId, typ: "JWT" })}.${part({ iss: issuerId, iat, exp: iat + 600, aud: "appstoreconnect-v1" })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: p8, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${signature.toString("base64url")}`;
}

/** Registers one iPhone in the Apple developer account; a UDID Apple already has counts as registered. */
export async function registerDevice(
  fetch: Deps["fetch"],
  token: string,
  device: Pick<Device, "udid" | "worker_id">,
): Promise<void> {
  const res = await fetch("https://api.appstoreconnect.apple.com/v1/devices", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        type: "devices",
        attributes: { name: `Eyes ${device.worker_id.slice(0, 8)}`, udid: device.udid, platform: "IOS" },
      },
    }),
  });
  if (res.ok) return;
  const body = await res.text();
  if (res.status === 409 && /already exists/i.test(body)) return;
  const detail = body.replaceAll(device.udid, short(device.udid)).slice(0, 500);
  throw new Error(`App Store Connect HTTP ${res.status} registering ${short(device.udid)}: ${detail}`);
}

/** UDIDs in a decoded provisioning profile, lowercased: iOS and Apple's portal disagree on UDID case. */
export function profileDevices(profile: string): Set<string> {
  const list = /<key>ProvisionedDevices<\/key>\s*<array>(.*?)<\/array>/s.exec(profile)?.[1] ?? "";
  return new Set(list.toLowerCase().match(/[0-9a-f-]{25,}/g));
}

/** Apple-registered UDIDs the profile lacks: those iPhones could not install the build. */
export function missingFromProfile(devices: Device[], provisioned: Set<string>): string[] {
  return devices
    .filter((d) => d.apple_registered_at && !provisioned.has(d.udid.toLowerCase()))
    .map((d) => d.udid);
}

/** Devices to release per phone: Apple-registered, not released yet, worker opted in, and in the build. */
export function releases(devices: Device[], provisioned: Set<string>): Map<string, Device[]> {
  const byPhone = new Map<string, Device[]>();
  for (const d of devices) {
    if (!d.apple_registered_at || d.released_at || !d.workers.opted_in) continue;
    if (!provisioned.has(d.udid.toLowerCase())) continue;
    byPhone.set(d.workers.phone, [...(byPhone.get(d.workers.phone) ?? []), d]);
  }
  return byPhone;
}

/** itms-services manifest: what iOS reads from the install link. */
export function manifestXml(urls: { ipa: string; icon57: string; icon512: string }, version: string): string {
  const asset = (kind: string, url: string) =>
    `        <dict><key>kind</key><string>${kind}</string><key>url</key><string>${xml(url)}</string></dict>`;
  return plist(`  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
${asset("software-package", urls.ipa)}
${asset("display-image", urls.icon57)}
${asset("full-size-image", urls.icon512)}
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>pictures.eyes.worker</string>
        <key>bundle-version</key><string>${xml(version)}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>Eyes</string>
      </dict>
    </dict>
  </array>`);
}

export async function main(argv: string[], deps: Deps): Promise<void> {
  const { dryRun, repo } = parseArgs(argv);
  const { env } = deps;
  const base = env.INSFORGE_BASE_URL?.replace(/\/+$/, "");
  const apiKey = env.INSFORGE_API_KEY;
  if (!base || !apiKey) throw new Error("Set INSFORGE_BASE_URL and INSFORGE_API_KEY (in .env).");
  const db = async (method: string, query: string, body?: object) => {
    const res = await deps.fetch(`${base}/api/database/records/worker_devices?${query}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(
        `InsForge ${method} worker_devices: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
      );
    return res;
  };
  const stamp = async (device: Device, column: "apple_registered_at" | "released_at") => {
    device[column] = deps.now().toISOString();
    await db("PATCH", `udid=eq.${encodeURIComponent(device.udid)}`, { [column]: device[column] });
  };

  // 1. Devices, with their worker.
  const select = "select=udid,worker_id,apple_registered_at,released_at,workers(phone,opted_in)";
  const devices = (await (await db("GET", select)).json()) as Device[];
  const pending = devices.filter((d) => !d.apple_registered_at);
  console.log(`worker_devices: ${devices.length}, waiting for Apple registration: ${pending.length}`);

  // 2. Register new iPhones with Apple.
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId } = env;
  const keyPath = `${env.HOME}/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`;
  const key = keyId && issuerId && existsSync(keyPath) ? { keyId, issuerId, keyPath } : undefined;
  if (pending.length) {
    const list = pending.map((d) => short(d.udid)).join(", ");
    if (dryRun) {
      console.log(`would register with Apple: ${list}`);
      if (!key) console.log(`no App Store Connect API key, so a real run stops here. ${NO_KEY}`);
    } else if (!key) {
      throw new Error(`${pending.length} device(s) wait for Apple registration. ${NO_KEY}`);
    } else {
      const token = ascToken(readFileSync(keyPath, "utf8"), key.keyId, key.issuerId, deps.now());
      for (const d of pending) {
        await registerDevice(deps.fetch, token, d);
        await stamp(d, "apple_registered_at");
      }
      console.log(`registered with Apple: ${list}`);
    }
  }

  // 3. Build the ad hoc .ipa.
  const mobile = join(repo, "apps/mobile");
  const tmp = mkdtempSync(join(tmpdir(), "eyes-adhoc-"));
  const archive = join(tmp, "Eyes.xcarchive");
  const exportOptions = join(tmp, "ExportOptions.plist");
  const auth = key
    ? [
        "-authenticationKeyPath",
        keyPath,
        "-authenticationKeyID",
        key.keyId,
        "-authenticationKeyIssuerID",
        key.issuerId,
      ]
    : [];
  console.log(`building ${mobile} in ${tmp}`);
  if (!existsSync(join(mobile, "node_modules"))) deps.exec("npm", ["ci"], mobile);
  deps.exec("env", ["CI=1", "npx", "expo", "prebuild", "-p", "ios", "--no-install"], mobile);
  deps.exec("pod", ["install"], join(mobile, "ios"));
  deps.exec(
    "xcodebuild",
    [
      ...["-workspace", "ios/Eyes.xcworkspace", "-scheme", "Eyes", "-configuration", "Release"],
      ...["-archivePath", archive, "-destination", "generic/platform=iOS", `DEVELOPMENT_TEAM=${TEAM_ID}`],
      // Unsigned: the export signs with the distribution identity, so no development certificate is needed.
      ...["CODE_SIGNING_ALLOWED=NO", "-allowProvisioningUpdates", ...auth, "archive"],
    ],
    mobile,
  );
  writeFileSync(
    exportOptions,
    plist(`  <key>method</key><string>release-testing</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>destination</key><string>export</string>`),
  );
  deps.exec(
    "xcodebuild",
    [
      ...["-exportArchive", "-archivePath", archive, "-exportPath", join(tmp, "export")],
      ...["-exportOptionsPlist", exportOptions, "-allowProvisioningUpdates", ...auth],
    ],
    mobile,
  );
  const ipa = join(tmp, "export/Eyes.ipa");

  // 4. Every Apple-registered iPhone must be in the build's profile.
  const provision = "Payload/Eyes.app/embedded.mobileprovision";
  deps.exec("unzip", ["-o", "-q", ipa, provision, "-d", join(tmp, "ipa")], tmp);
  deps.exec(
    "security",
    ["cms", "-D", "-i", join(tmp, "ipa", provision), "-o", join(tmp, "profile.plist")],
    tmp,
  );
  const provisioned = profileDevices(readFileSync(join(tmp, "profile.plist"), "utf8"));
  const missing = missingFromProfile(devices, provisioned);
  if (missing.length) {
    throw new Error(
      `profile missing ${missing.length} device(s) (${missing.map(short).join(", ")}); rerun after Xcode refreshes the profile`,
    );
  }
  console.log(`profile: ${provisioned.size} device(s), none missing`);

  // 5. Upload: .ipa first, manifest last. 6. Text each worker once, then mark the devices released.
  const version: string = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo.version;
  const texts = releases(devices, provisioned);
  const released = [...texts.values()].flat().length;
  if (dryRun) {
    const url = (name: string) => `${base}/api/storage/buckets/apps/objects/eyes-worker/${name}`;
    console.log(
      manifestXml(
        { ipa: url("Eyes.ipa"), icon57: url("icon-57.png"), icon512: url("icon-512.png") },
        version,
      ),
    );
    console.log(
      `dry run, nothing registered, written, uploaded or texted: ${pending.length} to register, Eyes ${version} for ${provisioned.size} device(s), ${texts.size} worker(s) to text (${released} device(s))`,
    );
    return;
  }
  for (const size of ["57", "512"]) {
    deps.exec(
      "sips",
      ["-z", size, size, join(mobile, "assets/icon.png"), "--out", join(tmp, `icon-${size}.png`)],
      tmp,
    );
  }
  const put = (name: string, body: Blob) => deps.upload(`eyes-worker/${name}`, body);
  const file = (path: string, type: string) => new Blob([readFileSync(path)], { type });
  // iOS fetches the .ipa from the API (no redirect); ?v= from storage makes each build a new URL.
  const ipaVersion = new URL(await put("Eyes.ipa", file(ipa, "application/octet-stream"))).search;
  const api = (env.EYES_PUBLIC_API_URL ?? "https://api.eyes.pictures").replace(/\/+$/, "");
  const urls = {
    ipa: `${api}/w/app/Eyes.ipa${ipaVersion}`,
    icon57: await put("icon-57.png", file(join(tmp, "icon-57.png"), "image/png")),
    icon512: await put("icon-512.png", file(join(tmp, "icon-512.png"), "image/png")),
  };
  await put("manifest.plist", new Blob([manifestXml(urls, version)], { type: "application/xml" }));
  // Each text carries a fresh location code (as the engine mints them), so the install page and then the app
  // connect without the worker texting APP again. Only its hash is stored; the code rides in the fragment.
  const web = (env.EYES_WORKER_WEB_URL ?? "https://app.eyes.pictures").replace(/\/+$/, "");
  for (const [phone, group] of texts) {
    const code = randomBytes(32).toString("base64url");
    const res = await deps.fetch(`${base}/api/database/rpc/eyes_rotate_location_token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_worker_id: group[0]?.worker_id,
        p_token_hash: createHash("sha256").update(code).digest("hex"),
      }),
    });
    if (!res.ok) throw new Error(`InsForge rpc eyes_rotate_location_token: HTTP ${res.status}`);
    await deps.sendText(phone, `${INSTALL_TEXT} ${web}/install#c=${code}`);
    for (const d of group) await stamp(d, "released_at");
  }
  console.log(
    `done: ${pending.length} registered with Apple, Eyes ${version} uploaded for ${provisioned.size} device(s), ${texts.size} worker(s) texted (${released} device(s) released)`,
  );
}

/* v8 ignore start -- process entry: real .env, network, child processes, storage and texts; run `pnpm adhoc:release --dry-run` */
if (import.meta.main) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = process.env;
  let messaging: ReturnType<typeof createInkboxMessaging> | undefined;
  await main(process.argv.slice(2), {
    env,
    fetch,
    exec: (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" }),
    upload: async (key, body) => {
      const baseUrl = String(env.INSFORGE_BASE_URL);
      const bucket = createAdminClient({ baseUrl, apiKey: String(env.INSFORGE_API_KEY) }).storage.from(
        "apps",
      );
      // Same key every release: the install page links the manifest URL, so replace, never rename.
      await bucket.remove(key);
      const { data, error } = await bucket.upload(key, body);
      if (!data) throw error;
      const url = new URL(data.url, baseUrl).href;
      // Storage answers `…/objects/eyes-worker%2FEyes.ipa?v=<hash>`; the ?v busts the CDN cache after a replace.
      if (!decodeURIComponent(new URL(url).pathname).endsWith(`/${key}`))
        throw new Error(`storage saved ${key} as ${url}`);
      return url;
    },
    sendText: (to, text) => {
      messaging ??= createInkboxMessaging(env);
      return messaging.sendText(to, text);
    },
    now: () => new Date(),
  }).catch((err: unknown) => {
    console.error(mask(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
/* v8 ignore stop */
