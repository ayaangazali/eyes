# Email channel

Workers can add one optional email address. Eyes uses it to send task offers, capture links and paid notices, and to sign you in to your setup page at `/me`. A mobile number is still required for every worker. **Use iMessage only** skips the optional email step without adding or verifying an address or sending email.

## How it works

- Every worker needs a mobile number. Each account has one phone. You can't change it yourself; text HELP to ask.
- Each account has at most one email.
- After START, text EMAIL to Eyes in your existing iMessage thread. Eyes replies with a one-time link, valid for 24 hours, to send your first email. An authenticated message carrying that code connects its sender's email address.
- An email entered at join stays pending until your phone texts START. For that separate flow, Eyes sends a one-time verification link valid for 24 hours. A join-form email is dropped if START comes more than 24 hours after joining.
- Email replies YES, STOP and HELP work the same as texts.
- Worker email uses `work@<PRIMITIVE_DOMAIN>` as its reply address, from the configured Primitive domain. Reply to the address supplied in the message.
- STOP pauses task offers, clears the stored location and revokes location codes. Known implementation gap: SMS STOP does not delete the saved email address. To remove it, text EMAIL OFF or use **Remove** on `/me`.

## How to try it

1. Join at https://app.eyes.pictures with your mobile number.
2. From your phone, text START.
3. Reply EMAIL in your existing Eyes iMessage conversation. We’ll reply with a link to send your first email. Open it and send the prepared message from the address you want to use.
4. Refresh your setup page at `/me`. The Email row shows your address (masked); it has text instructions, not an Add email button or provider chooser.
5. Later, sign in at https://app.eyes.pictures/login: enter that email, tap "Email me a sign-in link", and open the link within 15 minutes.

Send from an address your mail provider verifies; custom aliases need SPF/DKIM. The known custom-alias authentication problem is not fixed.

To change the email, text EMAIL in the same iMessage thread and send the prepared message from the new address. Remove on `/me` stops email right away; texts keep coming.

Primitive outbound DNS and one owner-email delivery are verified, not delivery to every domain. `send_to_any_domain` remains false; first-contact sends rejected by Primitive still use the Inkbox fallback.

## Where in the code

- [`packages/comms/src/primitive.ts`](../../packages/comms/src/primitive.ts): sends and receives email through Primitive.
- [`packages/comms/src/inkbox.ts`](../../packages/comms/src/inkbox.ts): Inkbox sends the first email that Primitive refuses.
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): task offers and worker replies. Email replies use the same path as texts.
- [`apps/mcp/src/server.ts`](../../apps/mcp/src/server.ts): the `/status` email line and the `/w/me` route.
- [`apps/web/worker/src/me.ts`](../../apps/web/worker/src/me.ts) and [`apps/web/worker/src/pages/me.astro`](../../apps/web/worker/src/pages/me.astro): the `/me` setup page and its Email row.
- [`apps/web/worker/src/email.ts`](../../apps/web/worker/src/email.ts): the worker page's email calls; [`apps/web/worker/src/pages/login.astro`](../../apps/web/worker/src/pages/login.astro): `/login`, email sign-in and the emailed-link handler.
- [`apps/web/worker/src/pages/privacy.astro`](../../apps/web/worker/src/pages/privacy.astro): what we store and for how long.

## Related

- [iMessage dispatch](imessage-dispatch.md): the text flow that email runs alongside.
