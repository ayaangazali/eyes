import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ascToken,
  type Deps,
  type Device,
  main,
  manifestXml,
  missingFromProfile,
  parseArgs,
  profileDevices,
  registerDevice,
  releases,
} from "./adhoc-release.ts";

const U1 = "00008110-001A2B3C4D5E801E";
const U2 = "00008120-00AA11BB22CC33DD";
const dev = (udid: string, over: Partial<Device> = {}): Device => ({
  udid,
  worker_id: "fe436dc1-0000-4000-8000-000000000000",
  apple_registered_at: "2026-10-01T00:00:00Z",
  released_at: null,
  workers: { phone: "+15555550101", opted_in: true },
  ...over,
});
const profileXml = (...udids: string[]) =>
  `<plist><dict><key>ProvisionedDevices</key>\n<array>${udids.map((u) => `<string>${u}</string>`).join("")}</array></dict></plist>`;
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("helpers", () => {
  it("parseArgs: defaults and flags", () => {
    expect(parseArgs([])).toMatchObject({ dryRun: false });
    expect(parseArgs(["--dry-run", "--repo", "/tmp/x"])).toEqual({ dryRun: true, repo: "/tmp/x" });
  });

  it("ascToken is an ES256 JWT for App Store Connect, valid 10 minutes, that verifies", () => {
    const token = ascToken(P8, "KEY123", "issuer-1", new Date(1_000_000_000_000));
    const [h, p, sig] = token.split(".") as [string, string, string];
    const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
    expect(json(h)).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(json(p)).toEqual({
      iss: "issuer-1",
      iat: 1_000_000_000,
      exp: 1_000_000_600,
      aud: "appstoreconnect-v1",
    });
    const ok = createVerify("sha256")
      .update(`${h}.${p}`)
      .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  it("registerDevice: 201 and 409 already-exists are fine; other errors name a UDID prefix only", async () => {
    const reply = (status: number, body = "") =>
      (async () => new Response(body, { status })) as Deps["fetch"];
    await registerDevice(reply(201), "t", dev(U1));
    await registerDevice(reply(409, "ENTITY_ERROR: A device with this number already exists"), "t", dev(U1));
    const err = await registerDevice(reply(409, `invalid UDID ${U1}`), "t", dev(U1)).catch((e: Error) => e);
    expect(String(err)).toContain("HTTP 409 registering 000081");
    expect(String(err)).not.toContain(U1);
    const calls: [string, RequestInit | undefined][] = [];
    await registerDevice(
      async (url, init) => {
        calls.push([url, init]);
        return new Response(null, { status: 201 });
      },
      "tok",
      dev(U1),
    );
    expect(calls[0]?.[0]).toBe("https://api.appstoreconnect.apple.com/v1/devices");
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      data: { type: "devices", attributes: { name: "Eyes fe436dc1", udid: U1, platform: "IOS" } },
    });
  });

  it("profileDevices/missingFromProfile/releases: case-insensitive, only registered + opted-in + unreleased", () => {
    const set = profileDevices(profileXml(U1.toLowerCase()));
    expect(profileDevices("<plist/>").size).toBe(0);
    const devices = [
      dev(U1),
      dev(U2),
      dev("00008130-0000000000000003", { apple_registered_at: null }),
      dev("00008130-0000000000000004", { released_at: "2026-10-02T00:00:00Z" }),
      dev("00008130-0000000000000005", { workers: { phone: "+15555550102", opted_in: false } }),
    ];
    expect(missingFromProfile(devices, set)).toEqual([
      U2,
      "00008130-0000000000000004",
      "00008130-0000000000000005",
    ]);
    const both = profileDevices(profileXml(U1, U2, dev(U1, { udid: "x" }).udid));
    const second = dev("00008110-001A2B3C4D5E8099");
    const out = releases([...devices, second], new Set([...both, second.udid.toLowerCase()]));
    expect([...out.keys()]).toEqual(["+15555550101"]);
    expect(out.get("+15555550101")?.map((d) => d.udid)).toEqual([U1, U2, second.udid]);
  });

  it("manifestXml names the ipa, icons, bundle id and version, escaped", () => {
    const xml = manifestXml(
      { ipa: "https://s/a.ipa?x=1&y=2", icon57: "https://s/57.png", icon512: "https://s/512.png" },
      "1.0.0",
    );
    expect(xml).toContain(
      "<string>software-package</string><key>url</key><string>https://s/a.ipa?x=1&amp;y=2</string>",
    );
    expect(xml).toContain("<string>pictures.eyes.worker</string>");
    expect(xml).toContain("<key>bundle-version</key><string>1.0.0</string>");
  });
});

describe("main", () => {
  type Call = { method: string; url: string; body?: unknown };
  function setup(devices: Device[], opts: { key?: boolean; nodeModules?: boolean; profile?: string[] } = {}) {
    const home = mkdtempSync(join(tmpdir(), "adhoc-home-"));
    const repo = mkdtempSync(join(tmpdir(), "adhoc-repo-"));
    mkdirSync(join(repo, "apps/mobile/assets"), { recursive: true });
    writeFileSync(join(repo, "apps/mobile/app.json"), JSON.stringify({ expo: { version: "1.0.0" } }));
    if (opts.nodeModules !== false) mkdirSync(join(repo, "apps/mobile/node_modules"));
    if (opts.key) {
      mkdirSync(join(home, ".appstoreconnect/private_keys"), { recursive: true });
      writeFileSync(join(home, ".appstoreconnect/private_keys/AuthKey_K1.p8"), P8);
    }
    const calls: Call[] = [];
    const execs: string[][] = [];
    const uploads: string[] = [];
    const manifests: string[] = [];
    const texts: [string, string][] = [];
    const write = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    const deps: Deps = {
      env: {
        INSFORGE_BASE_URL: "https://db.test/",
        INSFORGE_API_KEY: "k",
        HOME: home,
        ...(opts.key && { ASC_KEY_ID: "K1", ASC_ISSUER_ID: "iss" }),
      },
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url, body: init?.body && JSON.parse(String(init.body)) });
        if (url.startsWith("https://api.appstoreconnect.apple.com"))
          return new Response(null, { status: 201 });
        return new Response(method === "GET" ? JSON.stringify(devices) : null, {
          status: method === "GET" ? 200 : 204,
        });
      },
      exec: (cmd, args) => {
        execs.push([cmd, ...args]);
        if (cmd === "xcodebuild" && args[0] === "-exportArchive")
          write(join(args[args.indexOf("-exportPath") + 1] ?? "", "Eyes.ipa"), "ipa");
        if (cmd === "security")
          write(args.at(-1) ?? "", profileXml(...(opts.profile ?? devices.map((d) => d.udid))));
        if (cmd === "sips") write(args.at(-1) ?? "", "png");
      },
      upload: async (key, body) => {
        uploads.push(key);
        if (key.endsWith("manifest.plist")) manifests.push(await body.text());
        return `https://db.test/api/storage/buckets/apps/objects/${key.replace("/", "%2F")}?v=abc`;
      },
      sendText: async (to, text) => void texts.push([to, text]),
      now: () => new Date("2026-10-18T00:00:00Z"),
    };
    return { deps, repo, calls, execs, uploads, texts, manifests };
  }

  it("needs InsForge settings", async () => {
    const { deps } = setup([]);
    await expect(main([], { ...deps, env: {} })).rejects.toThrow("INSFORGE_BASE_URL");
  });

  it("dry run: builds and checks, but registers, writes, uploads and texts nothing", async () => {
    const t = setup([dev(U1), dev(U2, { apple_registered_at: null })], { nodeModules: false });
    await main(["--dry-run", "--repo", t.repo], t.deps);
    expect(t.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(t.calls[0]?.url).toContain("https://db.test/api/database/records/worker_devices?select=");
    expect(t.execs.map((e) => e[0])).toEqual([
      "npm",
      "env",
      "pod",
      "xcodebuild",
      "xcodebuild",
      "unzip",
      "security",
    ]);
    expect(t.execs.find((e) => e[0] === "xcodebuild")).toContain("DEVELOPMENT_TEAM=2BPG8N4Z33");
    expect([t.uploads, t.texts]).toEqual([[], []]);
  });

  it("without a key, pending devices stop a real run before the build", async () => {
    const t = setup([dev(U1, { apple_registered_at: null })]);
    await expect(main(["--repo", t.repo], t.deps)).rejects.toThrow("1 device(s) wait for Apple registration");
    expect(t.execs).toEqual([]);
  });

  it("a registered iPhone missing from the build's profile stops before upload", async () => {
    const t = setup([dev(U1), dev(U2)], { profile: [U1] });
    await expect(main(["--repo", t.repo], t.deps)).rejects.toThrow("profile missing 1 device(s) (000081…)");
    expect(t.uploads).toEqual([]);
  });

  it("real run: register \u2192 build (with key auth) \u2192 upload ipa, icons, manifest last \u2192 one text per worker \u2192 mark released", async () => {
    const t = setup(
      [
        dev(U1, { apple_registered_at: null }),
        dev(U2),
        dev("00008130-0000000000000003", { released_at: "x" }),
      ],
      {
        key: true,
      },
    );
    await main(["--repo", t.repo], t.deps);
    const apple = t.calls.filter((c) => c.url.startsWith("https://api.appstoreconnect"));
    expect(apple).toHaveLength(1);
    const patches = t.calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => [decodeURIComponent(c.url.split("?")[1] ?? ""), c.body])).toEqual([
      [`udid=eq.${U1}`, { apple_registered_at: "2026-10-18T00:00:00.000Z" }],
      [`udid=eq.${U1}`, { released_at: "2026-10-18T00:00:00.000Z" }],
      [`udid=eq.${U2}`, { released_at: "2026-10-18T00:00:00.000Z" }],
    ]);
    expect(t.execs.find((e) => e[1] === "-exportArchive")).toContain("-authenticationKeyID");
    expect(t.execs.some((e) => e[0] === "npm")).toBe(false);
    expect(t.uploads).toEqual([
      "eyes-worker/Eyes.ipa",
      "eyes-worker/icon-57.png",
      "eyes-worker/icon-512.png",
      "eyes-worker/manifest.plist",
    ]);
    expect(t.texts).toEqual([
      ["+15555550101", "Eyes is ready: tap to install https://app.eyes.pictures/install"],
    ]);
  });

  it("surfaces an InsForge error", async () => {
    const t = setup([]);
    const deps = { ...t.deps, fetch: async () => new Response("nope", { status: 500 }) };
    await expect(main(["--repo", t.repo], deps)).rejects.toThrow(
      "InsForge GET worker_devices: HTTP 500 nope",
    );
  });
});
