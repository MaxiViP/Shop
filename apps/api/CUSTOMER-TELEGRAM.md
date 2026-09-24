# CUSTOMER Telegram Bot v2 — Phase 1

The customer bot is an interface to the existing OrderService and CoordinationService.
There is no second order state machine, cart, chat history, payment implementation, or price override.

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

/start and /menu show the current order, order history, relevant messages/questions and HTTPS
profile/shop links. /orders returns five orders at a time with bounded pagination.
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
- orderId: FK to the exact owned Order, ON DELETE CASCADE
- action: CHAT; step: PROMPT or TEXT
- promptMessageId: nullable until Telegram confirms the ForceReply prompt
- expiresAt, createdAt, updatedAt; indexes on expiresAt and orderId

There is one pending flow per customer identity, with a 10-minute expiry.
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

## Migration and later production prerequisites

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
Transport reliability/proxy/VPN work, payments initiated in Telegram, customer cart and Mini App
expansion remain outside this phase.
