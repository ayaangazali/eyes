import { createInkboxMessaging } from "../src/index.ts";

const [to, text = "Eyes test message. Reply YES if you got it."] = process.argv.slice(2);
if (!to) throw new Error("Usage: node packages/comms/scripts/send-test.ts <E.164 phone> [text]");
const sent = await createInkboxMessaging(process.env).sendText(to, text);
console.log(`queued ${sent.id}`);
