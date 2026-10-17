import { describe, expect, it } from "vitest";
import { agentEmailAddress, signToken } from "../packages/core/src/index.ts";
import { redact } from "./smoke-live.ts";

const AGENT_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";

describe("redact", () => {
  it("hides API keys, link tokens, email capability addresses and known secrets", () => {
    const token = signToken("link-secret-for-tests-0123456789", AGENT_ID);
    const email = agentEmailAddress("link-secret-for-tests-0123456789", AGENT_ID, "abc.primitive.email");
    const text = `key eyes_test_Zx9-Q_wErTy12 url https://eyes.test/topup/${token} mail ${email} other sk_custom_1`;
    const out = redact(text, ["sk_custom_1"]);
    for (const secret of ["Zx9-Q_wErTy12", token, email.split("@")[0] ?? email, "sk_custom_1"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("https://eyes.test/topup/");
  });

  it("leaves ids, hosts, timestamps and place names readable", () => {
    const text = `{"task_id":"${AGENT_ID}","label":"Ferry Building, San Francisco","at":"2026-10-17T19:00:00.000Z"} https://dark-wave-wfmpm.run.mcp-use.com/healthz`;
    expect(redact(text, [])).toBe(text);
  });
});
