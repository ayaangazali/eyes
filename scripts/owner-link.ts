import { signToken } from "../packages/core/src/util.ts";

const agentId = process.argv[2] ?? "";
const secret = process.env.EYES_LINK_SECRET;
const base = process.env.EYES_PUBLIC_API_URL?.replace(/\/+$/, "");

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId) || !secret || !base) {
  console.error(
    "Usage: EYES_LINK_SECRET=<same as the server> EYES_PUBLIC_API_URL=<public API URL> node scripts/owner-link.ts <agent_id uuid> [link_version after a revoke]",
  );
  process.exit(1);
}

const version = process.argv[3] ? `:${process.argv[3]}` : "";
console.log(`${base}/owner/${signToken(secret, `p:${agentId}${version}`)}`);
