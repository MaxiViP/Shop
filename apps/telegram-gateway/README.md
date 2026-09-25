# Telegram Gateway v1

Transport only, Node 24, no runtime dependencies. No Nest, Prisma, database,
orders, shopping cart, auth or business state. This is a separate deployable
artifact; adding it to the workspace does not install/start a server service.

## Topology

Outbound:
Moscow Nest API -> HTTP 127.0.0.1:19001 -> existing SSH tunnel ->
Amsterdam gateway 127.0.0.1:18080 -> HTTPS api.telegram.org.

Inbound:
Telegram -> HTTPS tg.korzinamarket.ru -> Amsterdam Caddy ->
127.0.0.1:19002 -> existing SSH reverse tunnel ->
Moscow API 127.0.0.1:4001.

The existing tunnel is infrastructure; this application neither starts nor
configures SSH. All CUSTOMER/STAFF business logic and webhook secret validation
remain in Moscow. These are two independent bots, not two webhooks for one bot.

## Gateway configuration

Only token variable names are documented; no real values belong in the repository:

- TELEGRAM_CUSTOMER_BOT_TOKEN: CUSTOMER upstream identity.
- TELEGRAM_STAFF_BOT_TOKEN: STAFF upstream identity; may remain absent during
  CUSTOMER-only rollout. Requests for an absent/invalid token receive static 503.
- No legacy token fallback on Amsterdam. If both tokens are set they must differ.
- Listen address is fixed in code to 127.0.0.1:18080; there is no wildcard-host
  environment override.

GET /health returns only {"ok":true}, including when tokens are absent.
It does not test Telegram, credentials or the tunnel.

POST /v1/customer/<method> and POST /v1/staff/<method> accept only:
sendMessage, answerCallbackQuery, editMessageReplyMarkup, editMessageText.
No incoming URL contains a token; no arbitrary destination or method is allowed.
The gateway has no webhook routes.

JSON object bodies only; 64 KiB byte limit, no compression/file upload.
Request/header timeout is 10 seconds, upstream fetch timeout 5 seconds, upstream
body limit 256 KiB. Each valid configured request gets exactly ONE upstream POST,
redirect:error, with no retry and no queue. The token is used only in the outbound
HTTPS Telegram URL; neither that URL nor request/response contents are logged.

HTTP status and Telegram response body are relayed without upstream response
headers/cookies. A credential echoed by the provider or an oversized/unreadable
response becomes static 502. Timeouts return static 504; other network errors
return static 502. Malformed successful responses remain malformed; message IDs
are never invented. The gateway does not interpret order or payment semantics.

The local listener plus authenticated SSH tunnel is the access boundary.
There is no additional gateway HTTP credential. Local processes on either VPS
must be trusted; never expose port 18080 or the tunnel forwarding port publicly.

## Moscow API switches

New optional variables, independent for each bot:

- TELEGRAM_CUSTOMER_GATEWAY_URL
- TELEGRAM_STAFF_GATEWAY_URL

Accepted format: http://127.0.0.1:<port> (optional trailing slash/outer whitespace).
No credentials, hostname, query, fragment or extra path. Invalid nonempty config
fails closed; it never silently chooses direct mode. An empty/unset variable
keeps that bot direct. No env files are supplied/modified by this change.

Existing Moscow token resolution remains:
CUSTOMER: TELEGRAM_CUSTOMER_BOT_TOKEN -> TELEGRAM_BOT_TOKEN.
STAFF: TELEGRAM_STAFF_BOT_TOKEN -> TELEGRAM_BOT_TOKEN.

The centralized bot-api matches its supplied token against these resolved values.
With either gateway enabled, unknown or ambiguous shared tokens fail closed before
sending. A unique legacy fallback is still identifiable. Moscow still needs its
existing CUSTOMER token for Mini App identity validation; OIDC/auth is unchanged.

With CUSTOMER gateway configured and distinct tokens, CUSTOMER uses
/v1/customer/<method>; STAFF continues direct unless its own URL is configured.
With both configured, each uses its corresponding path/token on Amsterdam.
Operators must provision matching bot identities on both hosts; generic health
deliberately does not expose token identity/availability.

## Delivery semantics and UNKNOWN

No fallback from gateway to direct Telegram, including timeout, reset, 5xx,
malformed JSON, or ok:true without a valid sent Message. Switching destination
or automatic resend after an uncertain result could duplicate a Telegram action.

- 403 (or Telegram error_code 403) remains blocked on Moscow.
- Other Telegram 4xx remains known rejection.
- Gateway internal errors are 5xx, never a fabricated Telegram 403.
- Success for message delivery still requires a positive safe integer message_id.
- CUSTOMER outbox UNKNOWN remains SENDING and is not automatically retried.
- CUSTOMER unbound ForceReply survives; /resume is explicit user recovery.
- STAFF COMMITTING/prompt revision behavior is unchanged.
- Business mutations never replay because a display or transport request failed.

Moscow uses 7 seconds for messages/ForceReply and 3 seconds for callback
acknowledgements and STAFF dashboard/keyboard edits. The normal delivery deadline
is deliberately longer than the gateway's 5-second upstream deadline. The
existing short operations may abort first; they retain UNKNOWN semantics without
fallback/retry while Amsterdam completes its single attempt. Neither timeout
was increased. Disconnecting/restarting does not prove the message was not sent.
Do not clear SENDING records or resend during a cutover without reconciliation.

## Local checks / artifact

From the workspace root:

    pnpm install --frozen-lockfile
    pnpm --filter telegram-gateway lint
    pnpm --filter telegram-gateway typecheck
    pnpm --filter telegram-gateway test
    pnpm --filter telegram-gateway build

Tests use loopback HTTP and mocked upstream fetch only, never real Telegram.
Deployable files are this app's package.json and dist/. No node_modules or
other workspace application is required at runtime. Use Node 24 on the host.

## Future templates (not installed)

deploy/telegram-gateway.service uses a dedicated non-root telegram-gateway
user/group. Prepare that service account and root-owned application files under
/opt/korzinamarket-gateway. The system manager reads the root-owned
/etc/korzinamarket-gateway/gateway.env (0600, parent directory 0700) and supplies
its environment to the unprivileged service. Never print/source/cat that file
during checks. No secret values belong in command history or journal output.
The template grants no filesystem write access; Node JIT is not disabled.

deploy/Caddyfile is an Amsterdam-only future template:
GET /health is generic Caddy health; only the two exact POST webhook paths go
through 127.0.0.1:19002. /v1/*, other API paths and port 18080 are not exposed.
No path stripping, header-secret replacement, access logging, body logging or
proxy retries are configured. Keep X-Telegram-Bot-Api-Secret-Token intact.
The global default logger removes the complete request field, including custom
webhook headers, from error logs too. Merge this into an existing global block;
do not enable separate unfiltered/debug loggers. See official Caddy documentation
for [handle routing](https://caddyserver.com/docs/caddyfile/directives/handle),
[global logging](https://caddyserver.com/docs/caddyfile/options#log) and
[field filtering](https://caddyserver.com/docs/caddyfile/directives/log#filter).

Validate these templates on the intended hosts before later installation; this
Windows implementation task does not modify Caddy/systemd/SSH on any server.

## Later staged rollout - instructions only

A. Deploy/start the isolated gateway in Amsterdam with the correct CUSTOMER
token (and optionally STAFF token). Validate local health. No Moscow transport
switch and no webhook change yet.

B. From Moscow verify http://127.0.0.1:19001/health through the existing tunnel.
This confirms transport reachability only, not Telegram credentials.

C. Set TELEGRAM_CUSTOMER_GATEWAY_URL=http://127.0.0.1:19001 in Moscow's API
environment through the existing secure process, then restart the API.
STAFF's gateway variable remains unset. Verify CUSTOMER outgoing operations;
do not automatically switch back on an UNKNOWN outcome.

D. Separately change CUSTOMER's one webhook to
https://tg.korzinamarket.ru/api/telegram/customer/webhook, preserving the existing
secret_token and allowed_updates=["message","callback_query"].
Test /start, catalog, cart, callbacks, ForceReply /resume and notifications.
STAFF webhook stays at its existing address. Do not call setWebhook from app startup.

E. After CUSTOMER stability, optionally provision/verify the STAFF token on
Amsterdam, enable TELEGRAM_STAFF_GATEWAY_URL and then move the STAFF webhook to
https://tg.korzinamarket.ru/api/telegram/webhook with its own unchanged secret
and allowed_updates=["message","callback_query"].

Telegram permits only one webhook per bot. Keep the identities and secrets
separate throughout. No Prisma migration or database change is needed.
This repository change does not execute any rollout step.
