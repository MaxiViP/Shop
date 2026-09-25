# CUSTOMER Telegram Bot v3 — Shopping Phase 1

The customer bot is an interface to the existing OrderService and CoordinationService.
There is no second order state machine, chat history, payment implementation, or price override.
The generic server cart and checkout added in v3 are documented below.

## Interfaces and identity

- CUSTOMER: POST /api/telegram/customer/webhook, unchanged CustomerWebhookGuard.
- STAFF: POST /api/telegram/webhook, unchanged staff authorization and callback routes.
- The customer guard remains fail-closed with its own secret and bot separation checks.
- Only private chats with a positive safe Telegram sender ID equal to chat.id are accepted.
- TelegramIdentity is resolved by immutable Telegram user ID on every update.
- All reads/decisions/chat use its User.id. No guest credentials or staff actor branch are used.
- Existing OIDC, Mini App authentication, profile metadata, sessions and User.phone are unchanged.
- /start activates the existing identity and clears its customer blocked flag. Unlinked users
  are directed to website Telegram login; they are not registered by an arbitrary bot command.

## Cabinet

/start and /menu show catalog/cart, the current order when present, order history,
relevant messages/questions, help and HTTPS profile/shop links. /orders returns five orders at a time with bounded pagination.
Customer-visible order labels use the first eight publicId characters; callbacks carry the full
validated UUID in compact hexadecimal form. Old menu/orders/current and order:<uuid> buttons work.

The order card shows requested and actual quantities, missing items, original/final amounts,
payment/delivery status and finalized extras. It displays five item/extra lines per page.
Data comes from the same customer OrderService.get used by the website; in particular,
unfinalized extras retain the existing website visibility policy.

Issue actions come from CoordinationService.view and customerIssueActions, also enforced by
CoordinationService.decide. Weight acceptance/reduction, removal, replacement acceptance and
whole-order cancellation carry the exact issue ID and version. Existing locks, idempotency,
payment/assembly checks, totals and cancellation rules remain authoritative.
A stale decision produces a safe refresh message. Telegram never edits normal item prices.

## Durable chat input

CustomerTelegramSession is separate from StaffTelegramSession. It contains:

- id: UUID identifying this particular reservation, never an authentication credential
- identityId: unique FK to TelegramIdentity, ON DELETE CASCADE
- orderId: nullable FK; required for CHAT and bound to the exact owned Order, ON DELETE CASCADE
- action: CHAT (PROMPT/TEXT) or CHECKOUT (validated checkout step, described below)
- promptMessageId: nullable until Telegram confirms the ForceReply prompt
- payload: optional validated checkout draft; CHAT stores no text payload
- expiresAt, createdAt, updatedAt; indexes on expiresAt and orderId

There is one pending flow per customer identity. CHAT expires after 10 minutes; CHECKOUT
expires after 30 minutes. Explicitly starting chat replaces a pending checkout; starting a
new checkout replaces pending chat. Neither operation consumes the cart or creates an order.
Database CHECK enforces CHAT with an owned-order reference/no payload and PROMPT/TEXT;
CHECKOUT requires no order reference, an object draft and a known step. The domain checks
ownership and validates every draft before business use; SQL does not duplicate Zod rules.
Starting input calls CoordinationService.reserveReply with an ownership check under the
order lock. The reservation is created before the network request. Attaching its prompt
requires the same reservation ID: a delayed response cannot recreate a canceled/replaced flow.

The customer must reply to that exact prompt. Ordinary messages, another prompt, another owner
or an expired flow cannot post. /cancel deletes the flow and serializes with reservation creation.
CoordinationService.post atomically deletes/claims the matching session and writes the normal
OrderChatMessage under the same transaction and order lock. Rate-limit or mutation failure
rolls back the claim. Concurrent delivery/replay of a ForceReply can create only one message.
No text payload is stored in the session.

Chat uses the existing 2,000-character limit, rate limit and read/unread counters.
Telegram displays one complete message per page and invokes the existing read operation
only after a display response with a valid message ID. Malformed success responses cannot
clear unread messages. Staff replies remain in the same website chat.

## Channel-specific outbox

NotificationChannel has SMS and TELEGRAM. Existing OrderNotification rows acquire SMS by
default. The original dedupeKey values remain unchanged. Uniqueness is (channel, dedupeKey);
status, attempts, sentAt and error belong to that particular delivery row.

Notification types:

| Type | Source / meaning |
| --- | --- |
| ACTION_REQUIRED | Waiting issue or replacement proposal; exact issue version |
| PAYMENT_READY | Finalized goods/payment amount ready, including restoration |
| ORDER_CONFIRMED | A real transition to confirmed |
| ASSEMBLY_STARTED | Assembly started or reopened |
| PAYMENT_RECEIVED | Successful domain payment confirmation |
| DELIVERY_CHANGED | OTHER delivery update/handoff or a real Yandex state/price change |
| ORDER_COMPLETED | Pickup completed or delivery completed |
| ORDER_CANCELED | Successful domain cancellation |
| CHAT_MESSAGE | A new staff-authored order chat message |

Issue and payment keys preserve the existing logical keys in both channels.
Lifecycle/chat rows reference the durable customer timeline message and use message:<id>.
No-op domain transitions create neither another message nor another delivery row.
OrderNotification.messageId is optional with ON DELETE SET NULL; removing notifications can
never remove chat history. Missing, unrelated or already-read chat messages are not delivered.
Superseded issue versions and obsolete lifecycle/delivery notifications are canceled, including
an earlier assembly-start event after reopening. Cancellation preserves the original recipient's
unread accounting; its separate lifecycle notification never exposes staff-only chat text.

SMS retains ACTION_REQUIRED/PAYMENT_READY, ORDER_SMS_ENABLED/provider availability,
templates, failure isolation and the existing staff retry operation. The retry selects only
the SMS composite key. Staff coordination's SMS history excludes Telegram rows.

StaffService, CoordinationService and DeliveryService only persist outbox/timeline data
on the business transaction connection. They never call the Telegram provider directly.
NotificationService preserves the existing SMS dispatch after commit. Telegram delivery runs
in the pending-row sweep every 30 seconds, so slow Telegram requests cannot hold open a
successful website/STAFF mutation. The two channel dispatchers cannot update each other's rows.
The durable sweep also covers restarts and Yandex background sync. This bounded sweep cleans up
at most 100 expired customer sessions; it does not retry existing SMS rows.

## Delivery safety

Telegram requires the order's current User -> TelegramIdentity, customerBotStartedAt,
no customerBotBlockedAt, and configured independent customer bot credentials.
An ineligible event is UNCONFIGURED and is not replayed retroactively on /start.
Telegram HTTP 403 records a blocked flag; a later /start clears it.

A delivery is atomically claimed from PENDING to SENDING before external HTTP.
There is a seven-second timeout, redirect:error, no automatic sendMessage retry and no proxy.
Known rejection becomes FAILED; uncertain network/HTTP 5xx/malformed responses (including
ok:true without a valid sent message ID) remain SENDING
with static TELEGRAM_OUTCOME_UNKNOWN. A crash after send/before storing SENT also leaves
SENDING. The sweep processes only PENDING: it must not blindly resend an uncertain outcome.
This favors avoiding duplicate notifications over guaranteed delivery during outages.
No provider errors, tokens, chat IDs or customer payloads are logged.

## Existing v2 migration and rollout history

Migration: prisma/migrations/20260924120000_customer_bot_v2/migration.sql.

SQL was generated from the HEAD schema and new schema, without a database diff.
It is transaction-wrapped; the old single-column unique index is dropped only after the
replacement channel/key index exists. It adds one table, one enum, seven existing-enum values,
channel NOT NULL DEFAULT SMS, nullable messageId, indexes and foreign keys.
It does not rebuild/delete business tables or change identity, phone, order, payment or auth data.
The repository uses PostgreSQL 18; all new NotificationType values are used only after commit.
Rollback of migration failure is atomic. A later application rollback needs a reviewed forward
compatibility plan: do not recreate the old single-column unique index once both channels contain
the same dedupeKey, and do not discard Telegram rows just to make an old binary work.

A FRESH production PostgreSQL backup and verification are mandatory before later deployment.
Coordinate API workers and migration/new binary rollout: the old Prisma client expects the
previous unique-key shape. Do not run old writers across the uniqueness switch.
Build and validate the new API/generated Prisma client before migration, while all old writers
are stopped (or in a separate release directory). Then migrate and start only the matching new
API; never automatically restart an old writer if migration has committed. Check health, migration state,
customer ownership, decisions, chat, SMS retry and both bot regressions.

No new env variables or bot identities are required. Keep the existing separated CUSTOMER/STAFF
tokens/secrets and HTTPS ORDER_SITE_URL. Customer webhook allowed_updates must include
message and callback_query (both were already used by the foundation).
There is no automatic webhook registration or production configuration change.
Transport reliability/proxy/VPN work, automatic acquiring and Mini App expansion remain outside this phase.

## CUSTOMER v3 shopping — Phase 1

Flow: /start → /catalog → /cart → checkout → normal Order → existing seller
assembly/coordination → final goods amount → payment details → «Я оплатил» →
staff verifies PAID → existing pickup/delivery.

Commands: /start, /menu, /catalog, /cart, /orders, /current, /messages,
/resume, /cancel, /help. Old v2 order/issue/message callbacks remain supported.

### Catalog and cart

Cart/CartItem are generic user-owned domain tables, not Telegram order tables.
One Cart per User; one item per product. GRAM quantities are grams; PIECE/BUNCH/PACK
are integer units. The same min/step/MAX_QTY rules and cartQuote/goodsLine functions
are authoritative. Minus clamps at minimum; removal is an explicit action.
There are at most 50 cart lines, with five displayed per Telegram page.

There are no prices in CartItem. Product.active is checked through the same quote
as website checkout; category navigation follows the storefront's active categories.
The storefront currently allows active products independent of category visibility
in its quote; this patch does not silently change that shared policy.
Product deletion cascades only its cart lines, never order history.

Every cart write requires the displayed Cart.revision UUID, takes the user's/cart's
database lock, and replaces the revision. Replayed increment/add/clear callbacks
cannot apply to a later version. Product-card quantity controls are absolute
selection, not repeated increments of persisted cart state.
The website's browser/Pinia cart is intentionally unchanged and separate for now.
CartService is reusable for a later explicit website-cart migration.

### Durable checkout

CustomerTelegramSession extends only with nullable orderId and optional JSON payload.
CHECKOUT has no order before commit; CHAT still requires the exact owned order.
The payload is validated using checkoutPayload and the existing order/address schemas.
It holds only draft contact/address/time, cart revision, quote fingerprint and an
optional owned saved-address reference. It never holds trusted prices or requisites.

Pickup and delivery use the normal checkout fields. Existing account name/contact or
owned order history can prefill contact data. Telegram profile phone is never used
automatically and never copied to User.phone. Saved addresses are checked for ownership
again when selected. All data is shown for confirmation and can be edited.
The schedule uses Moscow time; '-' requests the earliest supported fulfillment.
Normal ShopSettings checkout limits are checked again before order creation.

Every step/resume changes the session UUID (the revision); timestamps are not locks.
Draft state is committed before sending ForceReply. A failed/unknown send leaves
promptMessageId null. Only a reply to the positively acknowledged exact prompt may
advance. /resume rotates the revision, invalidates prior prompts/buttons and presents
the current step. Concurrent/delayed sends can bind only the current revision.
No blind sendMessage retries. /cancel deletes the pending flow. Checkout Cancel buttons
carry the session revision, so an old button cannot delete a resumed/replaced flow.
Checkout expiry is 30 minutes; chat remains 10 minutes, with the existing bounded cleanup.

Final confirmation locks the identity and cart, validates the session UUID and cart
revision, locks current product rows, and re-runs the authoritative quote/checkout
validation. OrderService.createIn uses the SAME creation code as website create().
Session consumption, normal Order/OrderItem creation, cart clearing and a new cart
revision all commit in ONE PostgreSQL transaction. Failure rolls back all of them.
Concurrent/replayed confirmation creates at most one order. A changed cart cannot be
cleared by an old confirmation. No persistent COMMITTING fence is necessary here
because there is no external business operation outside that atomic transaction.

After commit, the existing best-effort STAFF new-order notice runs; it cannot roll
back/repeat checkout. A lost confirmation display is recovered via /current or /orders.
If the database commit acknowledgement is lost, a later retry either sees no session
(commit happened) or the untouched session/cart (rollback); it cannot duplicate the order.
Price changes require a fresh confirmation (/resume refreshes a confirmation quote);
cart-content changes require reopening checkout from /cart.

CHAT shares the same revision/resume principles. The existing CoordinationService.post
still atomically consumes its reservation, rate-limits, creates OrderChatMessage and
updates unread counters. No second chat history or issue state machine was added.

### Manual payment reporting

OrderPayment remains authoritative:
- AWAITING: funds are expected.
- REPORTED: customer says the transfer was made, NOT bank verification.
- PAID: existing staff verification recorded the internal actor.
- CANCELED: the existing domain invalidated payment.

Payment details come only from existing paymentDetails() configuration. Requisites are
displayed only to the owned order's customer, never in callbacks, logs, or chat history.
QR/link-based payment falls back to the owned website order page; no media fetch occurs.
The customer selects a configured method and presses «Я оплатил».
OrderService.reportPayment performs the existing ownership/state/method checks under
the Order lock. Only the first AWAITING → REPORTED transition creates a staff-only system
message/unread signal. After commit, a best-effort STAFF notice shows amount/method.
Replays create no additional message/notice; PAID cannot regress.
The durable staff chat signal remains even if Telegram is unavailable. The one-shot
notice deliberately is not blindly retried after an unknown network outcome.

Staff sees the existing payment confirmation action and a clear REPORTED warning.
StaffService.confirmPayment and its audit remain unchanged. Existing requirePaid
checks in StaffService/DeliveryService still gate delivery and pickup operations.
Reporting never arranges delivery automatically. Goods payment and delivery charge
retain the current domain separation.

There is no acquiring provider in Phase 1. A future provider should have its own
authenticated, idempotent callback adapter and verified-payment domain operation
that shares the existing payment/Order lock, audit and notification rules.
It must never treat the customer report endpoint as bank proof or reuse a human
staff actor for an unauthenticated provider. No speculative provider schema was added.

### Migration and later rollout

New migration: 20260925120000_customer_shopping.
Adds Cart, CartItem, ownership/FK indexes and integer-quantity CHECK; extends only
CustomerTelegramSession.orderId nullability and optional payload. Existing CHAT rows,
orders, users, payments, SMS/Telegram outbox rows and enums are preserved.
The existing order/identity cascade behavior is unchanged. No table drop/rebuild,
data rewrite, credential fields, destructive operation or enum change.

The migration also adds a session shape CHECK; existing valid PROMPT/TEXT rows remain unchanged.
It rejects invalid action/order/step/prompt combinations without rewriting existing data.
The migration is transaction-wrapped. New non-null fields exist only in new empty
tables; Cart.revision UUID is supplied by the generated Prisma client.
Review tested migration on a populated disposable PostgreSQL schema and existing
CHAT sessions, rollback behavior, FK cascades and real concurrent requests.

A FRESH VERIFIED production PostgreSQL backup is REQUIRED before later deployment.
Build the matching API/generated client first. Stop all API/background writers before
migration and start only the matching version afterward: old customer handlers cannot
interpret CHECKOUT/null orderId sessions. Do not run a mixed-version rollout or simply
restart an old binary after new checkout rows exist. Then verify migration/health,
both bots, OIDC, cart/checkout, payment report/staff verification and delivery smoke tests.

No new env variables, webhook routes, allowed_updates, network configuration, bot
identities or secrets are required. Existing CUSTOMER/STAFF separation is unchanged.
No production action, migration deployment, webhook registration or provider call is
part of local development/validation.
