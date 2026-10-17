import { usdToCents } from "@eyes/core";
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY to your Stripe sandbox secret key.");
  process.exit(1);
}
const stripe = new Stripe(key);
if ((await stripe.balance.retrieve()).livemode) {
  console.error("Refusing to run: STRIPE_SECRET_KEY is a live-mode key. Use a sandbox or test-mode key.");
  process.exit(1);
}

const usd = Number(process.argv[2] ?? 100);
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
console.log(`${intent.id} ${intent.status}. Platform available balance: ${available}`);
