# Telegram customer authentication

Customer authentication is separate from Bot v1/v2. Bot notifications, staff
webhook secret, TELEGRAM_ADMIN_CHAT_IDS, StaffService and order transitions are
unchanged. Customer authentication does not grant staff permissions.

## Database and migration

Migration: prisma/migrations/20260921120000_telegram_identity/migration.sql.

- User.phone becomes nullable; existing phone values and the unique index stay.
- TelegramIdentity.telegramUserId is a unique BigInt (Telegram's numeric user ID).
- TelegramIdentity.userId is also unique: one Telegram account per User.
- User.telegramIdentity is optional. Identity deletion follows User deletion.
- TelegramAuthReplay stores only consumed proof hashes and expiration.
- No Order, Session, role or existing User data is rewritten.

The migration was not applied to the working database or production. Integration
tests apply migrations only inside a newly generated local test schema and remove
that schema afterwards.

## Telegram profile metadata

Additive migration: prisma/migrations/20260922190000_telegram_profile_metadata/migration.sql.
It adds TelegramIdentity.photoUrl and phoneNumber as nullable TEXT, and phoneVerified
as BOOLEAN NOT NULL DEFAULT false. Existing identities, phones, orders and sessions
are preserved. Review and apply this migration before running the updated API;
no new env values or BotFather settings are required by this patch.

OIDC picture and Mini App photo_url update the same identity's avatar. OIDC phone
metadata is stored only when a validated phone was actually supplied; a Mini App
login cannot set phone metadata. Omitted/null OIDC photo/phone fields retain stored
values. A supplied new phone without explicit verification resets phoneVerified
rather than inheriting the old number's verification. User.name is not overwritten.

GET /auth/me and successful login responses return telegram=null or a safe object
with connected, username, firstName, lastName, photoUrl, phoneNumber, phoneVerified.
No Telegram numeric ID, identity row ID or session fields are returned. /auth/me is
marked Cache-Control: no-store. The website renders this metadata separately from
User.phone, with an avatar fallback and badges only for actual connected/verified
states. Existing sessions see stored metadata immediately; missing metadata requires
a new Telegram login and, for the phone scope, the user's consent.

## Mini App

Configure the Mini App URL later as https://korzinamarket.ru/telegram.
That page loads the official Telegram Web App SDK only when opened, sends raw
Telegram.WebApp.initData, and navigates to /catalog after authentication.

POST /api/auth/telegram/mini-app accepts ONLY { initData: string }.
The server validates the official bot-token HMAC:
HMAC-SHA256(key="WebAppData", data=bot token), then HMAC of sorted decoded
key=value fields joined with LF, excluding hash (including signature if present).
Duplicate parameters, malformed JSON, unsafe IDs, bots, and invalid hashes fail.
auth_date must be at most 300 seconds old, with at most 30 seconds future skew.
User/profile fields are read only after signature validation.

Proof hashes derive from the verified canonical HMAC, so reordered parameters or
different URL encoding cannot bypass replay checks. A proof can create a session
only once. After a failed/expired/replayed launch, close and reopen the Mini App
to obtain fresh initData. No raw initData, JWT, bot token or OIDC token is stored.

## Website OIDC

Official Telegram Login documentation:
https://core.telegram.org/bots/telegram-login
Mini App validation:
https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

GET /api/auth/telegram/config exposes availability flags only.
POST /api/auth/telegram/start creates state, nonce and S256 PKCE verifier.
An AES-256-GCM authenticated/encrypted HttpOnly cookie retains the short-lived
flow; AUTH_SECRET derives its encryption key. The response contains only the
public authorization URL. No credentials/verifier/session token reach JS.

GET /api/auth/telegram/callback validates the state cookie and exchanges the code
on the backend using Basic client authentication and the exact registered URI.
Only fixed https://oauth.telegram.org endpoints are used; redirects are rejected.
Requests time out after 7 seconds each. Signing keys are cached for 60 seconds;
an unknown key fails closed until refresh. RS256 is required (BotFather default).
The signature, issuer, audience/authorized party, expiration, issued-at, optional
not-before and nonce are checked. The verified numeric id claim is the common
Bot/Mini App identity; opaque sub and mutable username are NOT identity keys.
Scopes are openid profile phone. Consented phone claims are validated as international
numbers (7-15 digits, optional leading +) and stored with a leading +. Verification
is true only for a signed boolean phone_number_verified=true. A missing phone is
allowed. These claims are profile metadata only, never User.phone or account-link
proof. Avatar URLs must be HTTPS (max 2048 characters, no URL credentials); the API
never fetches them. Static failure codes never include these values.

Success creates the regular SID cookie and redirects to the configured site
/profile. Failure clears the flow cookie and redirects to /telegram?error=login
with no provider details. There is no user-controlled return URL. State is also
consumed transactionally in TelegramAuthReplay. Telegram authorization codes
are exchanged only by the backend, never the browser.

No credentials or invalid config means website login is unavailable; it does not
prevent API startup, guest checkout, Bot v1/v2 or Mini App auth.

## User and session semantics

A transaction serializes registration by Telegram ID using a PostgreSQL advisory
lock; unique constraints are the final DB protection. Identity and User are
created together; a unique conflict retries once and rereads identity.
There are no orphan users after a rollback.
New users always have role USER, phone=null and verifiedAt=null.
Only the initial User.name is populated; later Telegram profile changes update
identity cache fields without overwriting a customized User.name.

Proof consumption and Session creation are in the same transaction. Expired
replay rows are removed opportunistically in batches of at most 100, using the
expiration index and SKIP LOCKED. No per-request unbounded cleanup/job is added.

Sessions reuse AuthService.createSession, SHA-256 tokenHash, random 32-byte token,
30-day TTL and the shared existing HttpOnly/Secure/SameSite=Lax cookie policy.
An existing SID is rotated/revoked on successful Telegram or phone login.
A current session belonging to a DIFFERENT identity is not silently linked:
ACCOUNT_LINK_REQUIRED. Log out to sign into another independent account.

Telegram login never claims guest orders by name, username or phone-like data.
The existing verified-phone + matching guest-token order attachment remains only
in the phone OTP path. Addresses/favorites/orders continue to use the same User.id.
Cart persistence/merging is unchanged; this stage does not add server cart sync.

Customer Telegram auth rejects ADMIN accounts and the configured admin phone
(including before role bootstrap); it never bypasses the existing
admin password channel. A SELLER role can only come from existing explicit DB/admin
role assignment. Membership in TELEGRAM_ADMIN_CHAT_IDS has no effect here.

## Phone attachment / account linking

After successful OTP verification:
- unauthenticated login retains the existing phone-account behavior;
- an authenticated User with phone=null can attach a FREE phone to the SAME User;
- the same account/phone is allowed;
- another account owns the phone: 409 ACCOUNT_LINK_REQUIRED, no merge/move/delete;
- changing an already assigned phone also requires a separate linking flow;
- configured admin phone or an ADMIN account cannot use this OTP attachment.

Per-phone and per-user transaction locks serialize concurrent attachment.
The unique phone index remains the final guard. No placeholder phones are used.
No SMS provider is installed; production OTP codes are not exposed or simulated.
Usable production OTP attachment still needs the separately configured SMS channel.

Not implemented: linking two existing accounts, staff identity linking, bot contact
handling, /start registration, phone-based Telegram account merging, synchronized
Telegram cart. Future contact handling must verify contact.user_id == sender.id
from a trusted webhook before offering phone attachment.

## Configuration for later (owner action, not performed here)

Existing server-only configuration:
- AUTH_SECRET: strong existing authentication secret; do not expose or rotate casually.
- TELEGRAM_BOT_TOKEN: existing secret for Mini App HMAC.
- ORDER_SITE_URL=https://korzinamarket.ru
- CORS_ORIGINS must include https://korzinamarket.ru exactly.

New server-only variables in /etc/korzinamarket/api.env:
- TELEGRAM_OIDC_CLIENT_ID: client ID issued by BotFather.
- TELEGRAM_OIDC_CLIENT_SECRET: corresponding secret.
- TELEGRAM_OIDC_REDIRECT_URI=https://korzinamarket.ru/api/auth/telegram/callback

Keep TELEGRAM_ADMIN_CHAT_IDS and TELEGRAM_WEBHOOK_SECRET as currently configured.
No customer credentials belong in Nuxt public runtimeConfig or git.

Later production sequence:
1. Back up the database and review the migration against staging with existing data.
2. Apply the reviewed migration with the existing deployment procedure BEFORE
   enabling new code. No migrate reset / destructive recreation is needed.
   After the patch is separately approved and published, the owner can run:
   sudo bash /opt/korzinamarket/deploy/deploy.sh
   The existing script loads /etc/korzinamarket/api.env, generates with --no-hints,
   builds, runs prisma migrate deploy, and only then restarts/health-checks services.
   No deployment script changes are required for this patch.
3. In BotFather > selected bot > Login Widget, register website origin
   https://korzinamarket.ru and exact callback URI above. Obtain client ID/secret;
   retain RS256 signing. Configure the server env securely.
4. Configure the bot's Mini App/menu URL to https://korzinamarket.ru/telegram.
   No webhook changes or production setWebhook are needed for customer auth.
5. Verify website login and Mini App on real Telegram clients after deployment,
   with one identity resolving to the same User; also verify guest checkout and Bot v1/v2.
6. Proxy/error monitoring must not record auth bodies, Cookie/Authorization headers,
   token responses, or full callback query strings containing authorization codes.

Origin validation is required for auth POSTs. Native Mini App clients use the site's
origin. Existing SameSite=Lax policy is preserved; third-party iframe/cookie blocking
in Telegram Web may prevent cookie persistence. Use the normal website login in
that browser instead; no insecure JS token fallback is provided.

Rate limiting reuses the existing per-process AttemptLimit. Multi-instance production
needs a shared ingress limiter as with existing OTP endpoints. Keep clocks synchronized.

## Checks

Unit tests generate HMAC data and RSA-signed ID tokens locally; all external fetch
calls are mocked. Integration tests require a localhost PostgreSQL DATABASE_URL
and use only a random temporary schema:
pnpm --filter api exec vitest run --config ./vitest.config.e2e.ts test/telegram-auth.e2e-spec.ts

No production Telegram requests, production env writes, migration deployment,
commit, push or deploy are performed as part of implementation.
