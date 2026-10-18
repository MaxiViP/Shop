# Responsive product images — stage 3B

The storefront consumes the optional [stage 3A API metadata](product-image-api.md).
The frontend flag `NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS=true` enables responsive
images; it defaults to `false` independently of the API flag. Only boolean `true`
or the string `true` enables it. Setting it to `false` restores original image
URLs without `srcset` or `sizes`. No environment or deployment configuration is
changed by this stage.

## Rendering and fallback

- Catalog, home and favorites share `ProductImage` through `ProductCard`.
  Gallery thumbnails use the same component; the main gallery image keeps the
  original URL.
- Candidates use actual pixel widths from supported, source-matching metadata.
  Invalid metadata falls back to the original. Known original dimensions add
  the native original as a larger candidate; equal widths are deduplicated.
- `sizes` follows the grid columns, gaps, container limit, page padding, card
  border, compact favorites and coarse-pointer landscape layout. Portrait
  images account for `object-fit: contain`; thumbnails account for `cover`.
  Card loading policy and layout stay unchanged.
- A variant error removes `srcset` and `sizes` and retries the original once.
  If the original also fails, the component renders its placeholder. Legacy
  images and gallery originals go directly to the placeholder on failure.
- A new keyed image element isolates each retry. Generation checks ignore errors
  from an earlier product or gallery selection. Product, image, URL or selected
  photo changes reset the error state.
- After mount and image element changes, `checkComplete()` detects an SSR image
  that failed before hydration attached its listener. It checks `complete`,
  `naturalWidth` and matching source attributes, so an old failed element cannot
  reject the pending original retry. An incomplete image stays visible and waits
  for its own load/error event.
- Saved favorites are restored with `onNuxtReady`. Nuxt's `app:mounted` can run
  before asynchronous hydration completes; restoring earlier changes the header
  counter before it matches the SSR markup.

## Verification

From the repository root:

```powershell
node --test apps/web/test/product-image.test.mjs apps/web/test/market-products.test.mjs apps/web/test/gallery-search.test.mjs apps/web/test/favorites-layout.test.mjs apps/web/test/favorites-plugin.test.mjs
node --test apps/web/test/*.test.mjs
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web build
node apps/web/test/product-image.smoke.mjs
git diff --check
```

The opt-in smoke runs the production build against a loopback fixture API and
temporary real photographs with verified stage 3A metadata. It uses an isolated
headless Chromium browser (`CATALOG_BROWSER_PATH`, default Edge on Windows) and
blocks external requests. It does not use a live database or production files.

The smoke checks loaded images using `complete`, positive `naturalWidth` and
`currentSrc`, waits for Nuxt hydration, and rejects hydration/runtime warnings.
It covers 390/1440 px at DPR 1/2/3, 639 px and mobile landscape, flag rollback,
portrait/tiny sources, compact favorites, home, virtual scrolling and gallery
selection. Controlled script/image response gates cover failure before
hydration, an image still pending at hydration, subsequent success/failure and
late errors from the previous gallery photo. Request counts must settle.

The machine-readable result is `work/product-image-frontend/report.json` with
`status: passed` only after all assertions succeed. Screenshots are supplementary.
`--fallback-only` writes a separate `fallback-report.json` for focused diagnosis.
Browser engines other than Chromium, real devices and production infrastructure
are outside these local checks. No push, deployment or production backfill is
part of stage 3B.

Verified locally on 2026-10-15: 399 frontend tests passed (including the 52-test
focused run), all 31 production-browser checks passed, and hydration/runtime
errors and external browser requests were zero. Frontend typecheck, lint,
production build and `git diff --check` passed.
