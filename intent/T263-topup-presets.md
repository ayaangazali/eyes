---
task: T263 one-tap top-up with preset amounts
files:
  - apps/mcp/src/widget.ts
  - apps/mcp/src/widget.test.ts
  - packages/payments/src/index.ts
  - packages/payments/src/index.test.ts
---

## Why

Issue #263 asks for a one-tap way for owners to add balance before Eyes runs ads.
Owners could only open one default Checkout link, and a low-balance Ask error showed a raw URL.
The owner console, the widget balance card and the widget low-balance Ask error now show $10, $20 and $50 buttons.
Each button opens the existing `GET /topup/:token?amount_usd=` route, which clamps the amount and starts Stripe Checkout.
The owner console also shows a low-balance notice when the balance cannot pay the smallest task.
Stripe settings, prices and the top-up route do not change.

## Verification

The widget and payments unit suites pass, including new cases for the preset links, the low-balance notice and the Ask error buttons.
Desktop and phone screenshots of the owner console and the widget compare the screens before and after the change.
