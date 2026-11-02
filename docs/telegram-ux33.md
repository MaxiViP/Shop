# Telegram UX 3.3 — STAFF

STAFF uses the existing Rich delivery/fallback pipeline and the shared order renderer. CUSTOMER presentation remains the default; STAFF selects its uppercase financial/payment/progress labels explicitly. No schema, pricing, fulfillment, permission or mutation changes are required.

## Screens

- `/work`: seven queues, counts on buttons only. The first action highlights work requiring the seller. “All orders” retains the existing active-order filter; its count sums mutually exclusive active statuses rather than overlapping issue queues.
- Queues: six orders per page. Each order has one button with number, status, server total, Moscow creation time and fulfillment method. Separate shortcuts retain urgent questions and accepted replacements; a third issue links to the complete issue list. Six orders leave room for all shortcuts within the existing 32-row keyboard and Rich block limits.
- Order: prominent number/status, fulfillment, final or preliminary total, truthful payment state, assembly progress and next action. The existing financial breakdown, customer details and item details remain available. REPORTED prompts verification and never displays payment received.
- Assembly: requested and actual quantities, actual weight and server line totals appear in a native Rich table. Saving a result retains the Rich next-item screen and correction action. Issue and extra-item lists put selection information on buttons without a second text list.
- STAFF send/edit uses the existing left-alignment and semantic emphasis pass, including HTML fallback. Force-reply input and protected confirmation flows keep their existing behavior.

Telegram Rich button text supports plain text, custom emoji and date/time fragments, not bold text. Order rows therefore use a clear `№`, status emoji and explicit financial labels; headings, paragraphs and tables carry native bold/marked formatting. See [RichMessageButton](https://core.telegram.org/bots/api#richmessagebutton) and [InputRichBlockButtons](https://core.telegram.org/bots/api#inputrichblockbuttons).

## Commands and rollout

`staff-commands.ts` defines start/work/orders/attention/waiting/resume/cancel/help. Existing `/order 123` remains supported, including `/order@BotUsername 123`. Every menu command routes through the existing authorized STAFF handler.

`scripts/telegram-staff-commands.mjs` registers only STAFF chat scopes supplied in a manifest, for default and Russian language. It requires the distinct STAFF token, backs up the previous scopes before applying, verifies Telegram's response, and supports restoration. Production rollout uses only the current STAFF Rich test allowlist. CUSTOMER commands, global command scopes, gateway transport policy and Rich allowlist stay unchanged.

Release the API only after profile/full API tests, CLI tests, typecheck, lint, build and the full Telegram PostgreSQL E2E set on an isolated database. Back up and verify database, uploads, runtime and configuration before activation. Keep the previous API runtime and source SHA for rollback without restoring production data. Preserve systemd units/overrides and existing Rich policy.

## Visual acceptance

On Telegram Desktop and Android, check `/work`, all queue filters and pagination; order buttons with Moscow time and pickup/delivery; urgent questions and accepted replacements; order total and REPORTED/PAID distinction; item quantities, weight, assembly progress and saved-result screen; all eight command-menu entries plus `/order 123`, `/resume` and `/cancel`. Exercise dangerous confirmations only with an agreed test order. Client layout requires user acceptance; API send/edit confirmation does not constitute visual acceptance.

## Verification on 2026-10-24

API typecheck (both configurations), lint, production build and `git diff --check` passed. Full API unit suite: 1950 passed, 21 skipped, 0 failed across 97 files. Telegram/cart/pricing profile: 861 passed. STAFF command registration CLI: 3 passed. Linux screen regressions: 47 passed. The complete three-file Telegram PostgreSQL E2E run: 177 passed, 0 skipped/failed against an isolated PostgreSQL 18 container. Logs and resumable release state are in the ignored `work/telegram-ux33/` directory.
