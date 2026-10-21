# Hackathon (YC Make Something Agents Want), vendor note
Fetched: 2026-10-16. Sources actually read:
- https://events.ycombinator.com/MakeSomethingAgentsWant (official event page, read via headless browser; plain fetch returns only the title because it is JS-rendered)
- https://t.co/eYmqcrfhD2 (redirects to the page above)
- https://x.com/rayruizhiliao/status/2098103367302283513 (host tweet; only seen via search snippet, direct fetch returned HTTP 402)
- Web searches for rules/devpost/luma: no other official page found.

The official page has NO rules section: no statement on pre-written code, team size, open source, AI coding tools, eligibility, judging criteria, or submission venue. Everything below is what the page says; gaps are in "Open questions".

## What Eyes uses it for
Target prize tracks (all names verbatim from the page): Manufact "Best MCP Server for Agents", Armature "Best Agent Experience (AX)", Insforge "Agent-Native Cloud", Primitive "Best Agent Communication Setup with Primitive.dev", Inkbox (persistent agent identity), Stripe (agent participating in the economy). Blaxel ("Something a Human Would Never Want") and Supabase (listed sponsor, no track published) are not in our stack.
Event framing: "Y Combinator's motto has always been 'make something people want.' It's increasingly 'make something agents want.'" Emphasis on agent experience (AX), headless MCPs rather than UIs and APIs, token-spend optimization, docs made for agents. Eyes (agent is the customer, MCP is the product) fits this directly.

## Rules that constrain us
No rules text is published on the event page. The page states only:
- "If you're an exceptional builder who wants to create for the future of agents as the user, join us at the Make Something Agents Want Hackathon hosted by YC teams building for agents."
- "This event is no longer accepting new registrations." Registration is closed; entry is by prior sign-in only. Confirm every teammate is on the list; doors open 9 AM with "Sign In".
- Pre-existing code / night-before scaffolding: NOT addressed anywhere we could read. Do not assume allowed or banned. See Open questions.
- Hacking officially begins 10:30 AM Oct 17 ("10:30 AM - Hacking Begins"). That is the only code-timing signal on the page.
Do not apply rules from other YC hackathons (e.g. a mirrored "First Overnight YC Agents Hackathon" page at glama.ai that mentions a 48-hour pre-code cutoff and 2/3 new code). That is a different event; it is only a hint at what YC-style organizers sometimes enforce.

## Schedule (Pacific, source: event page)
Oct 17 (Sat): 9:00 doors open + sign in; 10:00 kickoff; 10:30 hacking begins; 12:00 lunch; 12:15 lunch lightning talks; 17:00 dinner; 18:00 dinner lightning talks.
Oct 18 (Sun): 8:00 breakfast; 10:00 "Submissions Due + Live Demos"; 11:00 judging completes; 12:00 lunch; 12:15 winners announced; 13:00 hackathon ends.
Implication: roughly 23.5 hours of hacking; hard submission deadline 10:00 AM Sunday, and demos start at the same time. Code freeze should be around 9:30 AM.

## Judging criteria and each sponsor prize's stated criteria
General judging format (rounds, demo length, finalists, rubric): not published.

| Sponsor / track | Prizes | Stated criteria | Required usage | Judges |
|---|---|---|---|---|
| Manufact: Best MCP Server for Agents | 1st $2,000 cash + $6,000 Manufact credits; 2nd $700 + $3,000 credits; 3rd $300 + $300 credits | "Best MCP server built for agents as the primary customer." | Implied: MCP server (Manufact is the mcp-use / Manufact Cloud vendor) | Luigi Pederzani, Enrico Toniato, Andrew Khadder |
| Insforge: Agent-Native Cloud | 1st $1,000 cash (Visa gift card) + $1,000 cloud credits; 2nd $500 + $500; 3rd $300 + $300 | None stated beyond the track name | Implied: build on InsForge | Tony Chang, Hang Huang |
| Armature: Best Agent Experience (AX) | Winner $1,000 cash + $1,000 Armature credits; runner-up $500 + $500; third $300 + $300 | "Agents can use your product through a dedicated Agent-Facing Interface (MCP, CLI). Build the best experience for them!" | Implied: Armature analytics (verify) | Theodore Otzenberger, Louis Scremin |
| Primitive: Best Agent Communication Setup with Primitive.dev | Cash only: 1st $3k, 2nd $2k, 3rd $1k | "Give your agent an identity. Let it ask questions, receive replies, handle attachments & coordinate asynchronously. Then show us what you built." | Primitive.dev | Ethan Byrd, Ashley Ha, Ben Poile |
| Inkbox | 1st $1,000 cash + $1,000 Inkbox credits; 2nd $500 + $500; 3rd $200 + $200 | "Interesting projects giving agents a persistent identity with email, phone, iMessage, and A2A, so they can communicate with humans and each other" | Inkbox | not listed |
| Stripe | Stripe Credits: all participants $500; 1st $3k, 2nd $2k, 3rd $1k. Stripe Atlas: all participants 20% off (shared before hackathon); 1st/2nd/3rd winners fee waived (shared after) | "Build an agent that can safely participate in the economy: buy products, provision services, manage business spending, or pay for the resources it needs to complete a task. We're looking for useful, creative, end-to-end experiences that give users clear control over what their agents can do and spend." | Stripe (not explicitly stated) | not listed |
| Blaxel: Something a Human Would Never Want | 1st $1k cash (gift card) | none | Blaxel | not listed |
| Supabase | listed sponsor, no track | n/a | n/a | n/a |

Stripe angle worth stating in the demo: "clear control over what their agents can do and spend" maps to the prepaid balance, bounty cap, and escrow/refund. Stripe track wording is agent as buyer ("pay for the resources it needs"), which is exactly Eyes' agent paying a human.
Maximum stackable cash if Eyes wins every relevant track at 1st: Manufact 2,000 + Insforge 1,000 + Armature 1,000 + Primitive 3,000 + Inkbox 1,000 + Stripe 3,000 = $11,000 plus credits (it is unknown whether one project may win multiple tracks).

## Submission requirements and deadlines
- Deadline: Sunday Oct 18, 10:00 AM PT ("Submissions Due + Live Demos").
- Where/what (Devpost, form, repo link, video, description): NOT stated on the page. Likely handed out at kickoff. Ask organizers or check the sign-in email.
- Demo order, demo length, number of finalists: not stated. Judging completes by 11:00 AM, so judging appears to be live at tables/demos in a single hour, not a long staged pitch (inference).
- Winners announced 12:15 PM Oct 18.

## Credits, promo codes, onboarding links (publicly on the page)
- Stripe Atlas 20% off (all participants): https://dashboard.stripe.com/atlas/invite/tscmsezh
- Stripe Atlas fee waived (winners, "shared after hackathon"): https://dashboard.stripe.com/register/atlas?atlas_invite=se3u1wzs
- Stripe Credits $500 to all participants: redemption method not described. Ask the Stripe booth.
- Sponsor sites linked: armature.tech, blaxel.ai, inkbox.ai, insforge.dev, manufact.com, primitive.dev, stripe.com, supabase.com.
- Participant credits from other sponsors: none stated. Ask at the event.

## Contradictions with our plan
- Plan assumes scaffolding can be built the night before: page says nothing either way. Not a contradiction, but unverified; see below.
- Plan lists six sponsors; page lists eight (adds Blaxel, Supabase). No conflict. Armature prize is about AX through MCP/CLI; our Armature use as analytics is consistent but the prize does not name analytics.
- Plan treats Stripe test mode as sufficient: Stripe prize asks for "end-to-end experiences" with "clear control over what their agents can do and spend"; make spend limits and the refund path visible in the demo.
- Primitive prize is "agent communication ... receive replies, handle attachments, coordinate asynchronously" with an agent identity. Our plan uses Primitive for agent email only; make sure the demo shows an agent-side email thread (e.g. result delivery or follow-up questions) to qualify.

## Open questions / unverified
1. Whether code written, repos created, or scaffolding/boilerplate prepared before Sat 10:30 AM is allowed. NOT on the official page. Highest-risk item. Ask the organizer (host Ray Liao, @rayruizhiliao on X) or the kickoff speakers in writing before Saturday. Safest course: keep the night-before work to non-code prep (accounts, API keys, Stripe test setup, vendor notes, design) and start the repo at 10:30 AM, or disclose any prior scaffolding at submission.
2. Team size limit, open-source requirement, AI coding agent policy, eligibility: not published.
3. Judging rubric, demo length, finalist structure: not published.
4. Submission venue and format: not published.
5. Whether one project can win several sponsor tracks: not published.
6. Manufact/Insforge/Primitive/Blaxel mandatory-use requirements: only implied by track names.
7. The tweet text itself (https://x.com/rayruizhiliao/status/2098103367302283513) was only seen in a search snippet: "We are hosting a hackathon at YC October 17-18 with our friends from @ycombinator @stripe @primitive @insforge @ArmatureInc @blaxelAI @manufact".
