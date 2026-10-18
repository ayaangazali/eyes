import { usdToCents } from "@eyes/core";
import Stripe from "stripe";

export const KEY_HELP = "Set STRIPE_SECRET_KEY to your Stripe sandbox secret key.";

/** An input or environment problem the operator can fix. The entry point prints it without a stack trace. */
export class Refusal extends Error {}

/** The slice of the Stripe SDK this script uses. Injectable so tests never call Stripe. */
export type FundClient = {
  balance: { retrieve(): Promise<{ livemode: boolean; available: { amount: number; currency: string }[] }> };
  paymentIntents: { create(params: object): Promise<{ id: string; status: string }> };
};

/** The real Stripe client. Only the production entry point reaches it; tests inject a fake. */
export const defaultStripe = (key: string): FundClient => new Stripe(key);

export async function fundPlatform(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  makeStripe: (key: string) => FundClient = defaultStripe,
): Promise<string> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Refusal(KEY_HELP);
  const stripe = makeStripe(key);
  if ((await stripe.balance.retrieve()).livemode) {
    throw new Refusal(
      "Refusing to run: STRIPE_SECRET_KEY is a live-mode key. Use a sandbox or test-mode key.",
    );
  }
  const raw = argv[0] ?? "100";
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0)
    throw new Refusal(`Amount must be a positive number of USD, got "${raw}".`);
  const intent = await stripe.paymentIntents.create({
    amount: usdToCents(usd),
    currency: "usd",
    payment_method: "pm_card_bypassPending",
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    confirm: true,
    description: "Eyes platform pre-funding so test payouts have available balance",
  });
  const available = (await stripe.balance.retrieve()).available
    .map((b) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`)
    .join(", ");
  return `${intent.id} ${intent.status}. Platform available balance: ${available}`;
}

/* v8 ignore start -- process entry: reads real argv/env, calls Stripe, and sets the exit code; exercised by running the script directly */
if (import.meta.main) {
  try {
    console.log(await fundPlatform(process.argv.slice(2), process.env));
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
/* v8 ignore stop */
