import { createInkboxMessaging } from "../src/index.ts";

export const DEFAULT_TEXT = "Eyes test message. Reply YES if you got it.";
export const USAGE = "Usage: node packages/comms/scripts/send-test.ts <E.164 phone> [text]";

type Sender = { sendText(to: string, text: string): Promise<{ id: string }> };

/** Queues one test text and returns a one-line receipt. `make` is injectable so tests never reach the provider. */
export async function sendTest(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  make: (env: NodeJS.ProcessEnv) => Sender = createInkboxMessaging,
): Promise<string> {
  const [to, text = DEFAULT_TEXT] = argv;
  if (!to) throw new Error(USAGE);
  const sent = await make(env).sendText(to, text);
  return `queued ${sent.id}`;
}

/* v8 ignore start -- process entry: reads the real argv/env and prints; exercised by running the script directly */
if (import.meta.main) console.log(await sendTest(process.argv.slice(2), process.env));
/* v8 ignore stop */
