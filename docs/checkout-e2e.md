# Checkout E2E

The suite runs built Nuxt in Chromium against the real NestJS controllers,
services and Prisma models. Playwright covers checkout; the existing CDP smoke
scripts remain catalog/visual checks. Both use the existing local-only Nuxt
launcher (`apps/web/test/browser.mjs`). Production business logic is unchanged.

## Run

Use Node 24, pnpm 11, and Docker with the local socket. After `pnpm install`:

```sh
pnpm --filter web exec playwright install --with-deps chromium
pnpm test:checkout
```

An installed Chromium can be selected with `CATALOG_BROWSER_PATH`, for example:

```sh
CATALOG_BROWSER_PATH=/usr/bin/chromium pnpm test:checkout
```

The command generates Prisma, compiles/typechecks the API test harness, builds
Nuxt, launches the isolated stack, runs the browser matrix, then tears it down.
Run `pnpm typecheck`, `pnpm lint`, `pnpm build` and
`pnpm --filter web exec tsc -p test/checkout/tsconfig.json` for the other checks.

## Database and network isolation

By default the runner creates a uniquely-named PostgreSQL 18.6 container, with
a random password, no persistent volume, tmpfs data, and a randomly allocated
loopback port. It uses the explicit local Docker socket, never the shop compose
stack. The server creates a second, random `checkout_e2e_<uuid>` database,
applies every existing SQL migration, and drops only that database on exit.
Each test resets the contents of this newly-created database.

CI supplies a disposable PostgreSQL service. To use an equivalent dedicated
local instance, set `E2E_DATABASE_URL` explicitly. Only a `postgresql://` URL on
`127.0.0.1`, with database name `checkout_e2e` and no query parameters is accepted.
Never point it at an existing shop database. The database user must be allowed
to create databases. `DATABASE_URL` inherited from the shell is never used to
select the test database. No `.env` file, production credential or provider
configuration is inherited by the test API. No migrate reset is used.

The test executable composes existing modules, overrides only outbound
notification delivery and OTP rate limit guards (rate limiting is tested
separately), and keeps real OTP verification, cookies, cart, queue and pricing.
It exposes loopback-only control endpoints authenticated by a per-run random
token. None are imported into the production entrypoint or application build.
The API HTTP preload, Nuxt fetch guard, and Playwright routing block external
HTTP during tests. No real SMS, Telegram or courier requests are sent.

## Matrix and assertions

One worker runs the matrix sequentially, with a clean database and browser
context for every test. Tests have no automatic retries. Every scenario runs
for guests and OTP-authenticated customers at 390 × 844 and 1280 × 900:

- Delivery and pickup, both normal checkout and preorder while the shop is closed.
- Price changes between final quote refresh and the POST: real API rejection,
  preserved basket, explicit retry using the updated server price.
- Product made unavailable in the same race: no order, preserved basket, disabled checkout after reload.
- Selected slot filled by a competing order: real reservation rejection,
  preserved basket and checkout using another server-provided slot.
- API 500 before commit: no automatic POST retry, retained basket, deliberate
  retry with the same request ID and exactly one persisted order.
- Response lost after a real commit: replay resolves the existing order,
  without duplication. Guest UI retries; authenticated recovery uses an API
  replay and opens the recovered order explicitly (see limitation below).
- Invalid recipient: validation prevents POST and retains the basket.
- A real rapid double click while the first POST is held: disabled button,
  exactly one browser POST and exactly one persisted customer order.

Successful requests are also replayed concurrently with the same session and
request ID. Assertions inspect PostgreSQL orders/items/cart, ownership and
HttpOnly cookies, server monetary amounts, persisted schedule, and the empty
cart UI after success. Happy paths inject spoofed client totals/prices; the
actual server must ignore them and persist the expected 10% markup amounts.
Delivery fixtures qualify for real server-calculated free delivery. Paid
courier quoting, payment, assembly, and real SMS/Telegram are outside scope.
Opening hours are all-day fixtures except a current-day closure in preorder
tests; slots are taken from the real API rather than hardcoded dates.

## Artifacts and CI

`.github/workflows/checkout-e2e.yml` runs on PRs, main pushes and manual dispatch,
with read-only repository permissions. It performs typecheck, lint, build,
existing checkout regressions and the E2E suite. An `always()` artifact upload
retains runner/API/PostgreSQL/Nuxt logs, the HTML/JSON report, and failure traces,
screenshots, page HTML, browser logs and fixture database state for 14 days.
All local output is ignored under `work/checkout/`; no credentials or artifacts
are committed. Reports contain synthetic fixture data and temporary session
tokens; keep artifact access scoped to repository collaborators.

Authenticated lost-response limitation: the transaction clears the server cart
before the browser receives the response. On response loss the current UI
refreshes that empty cart instead of navigating to the order. Idempotent API
replay is verified, but automatic UI recovery is not implemented. Changing that
behavior requires a separately approved business/UI change.

Reproduce only the lost-response scenario on the isolated stack:

```sh
CATALOG_BROWSER_PATH=/usr/bin/chromium pnpm test:checkout --grep 'authenticated OTP customer.*lost response'
```

The interceptor forwards the POST to the real API, waits for the successful
commit, then drops its response. The database contains one order, the server
cart is empty, and the page remains on `/cart`. Replaying the captured payload
with the same session and `checkoutRequestId` returns the same order. The test
then explicitly opens that order; it does not claim automatic UI recovery.

## Verification report — 2026-10-13

Base main: `0486f0a363397a2c7e65c7cfa07ae16e4874bf30`.
Compatibility checkout: PR #2 head `0691d4a39ce9b5928c1e9aad516bc6ba6683ef2f`
plus this test-only change, in a separate worktree and PostgreSQL container.

| Local run | Passed | Failed | Skipped | Automatic retries |
| --- | ---: | ---: | ---: | ---: |
| Main + Checkout E2E | 44 | 0 | 0 | 0 |
| PR #2 + Checkout E2E | 44 | 0 | 0 | 0 |

Each run contains 22 mobile and 22 desktop cases. Each of the eleven scenarios
above runs in all four customer/viewport combinations. Main production
typecheck, lint and full monorepo build passed, as did the separate strict
TypeScript checks for the test server and Playwright. The six existing checkout
regression files passed with zero failing files. Remote-host and shop-database
connection guards were explicitly checked to reject before connection; fetch
and Node HTTP guards reject external origins before sending a request.

The diff applies cleanly to PR #2. The only common modified file is the root
`package.json`; its `test` and `check` scripts are preserved alongside
`test:checkout`. PR #2's source, schema, migration, cart and weighing fixes are
retained. Its new normalized-price migration is applied only in the random
compatibility test database. The combined checkout also passed typecheck,
lint, full monorepo production build and all six selected regression files.
Both per-run PostgreSQL containers were removed on completion.
No production source, authentication implementation, schema or migration
is modified by this PR.

Earlier diagnostic runs failed on test-only wiring (missing DbModule), invalid
fixture values (queue threshold and weekday numbering), and Playwright route
handler removal. These were corrected in test infrastructure, without changing
business code. Their browser failures produced screenshots and trace archives.
The table reports the completed verification runs, not those diagnostic runs.

Build warnings about unavailable external font metadata and a pg client query
deprecation did not fail the local builds or tests. Real devices, Firefox/WebKit,
paid courier quoting, real SMS and automatic authenticated lost-response UI
recovery remain outside the verified scope. GitHub Actions results must be
checked on the PR separately from these local results.

Changed files (14): `.gitignore`, `package.json`, `pnpm-lock.yaml`,
`.github/workflows/checkout-e2e.yml`, `scripts/checkout-e2e.mjs`,
`scripts/checkout-network.mjs`, `apps/api/test/checkout/server.ts`,
`apps/api/tsconfig.checkout.json`, `apps/web/package.json`,
`apps/web/test/browser.mjs`, `apps/web/playwright.checkout.config.ts`,
`apps/web/test/checkout/checkout.spec.ts`, `apps/web/test/checkout/tsconfig.json`,
and `docs/checkout-e2e.md`.
