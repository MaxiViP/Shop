# Product photo import: 2026-10-07

`2026-10-07/manifest.json` and its 146 WebP files are the versioned import source.
The manifest preserves the exported product slugs, names and MarketPoint slugs;
each entry adds a SHA-256 checksum. `product-photo-source/` and the root export
JSON files are staging inputs only. Neither the importer nor Nuxt reads them.

The batch contains `AI_PLACEHOLDER` catalog illustrations. The database uses the
existing `ProductImage` relation (`productId`, `url`, `alt`, `sort`, `visible`).
No Product fields or Prisma schema are changed. The accessible alt text marks
these as illustrations. Real market photos can replace them manually through
the existing admin upload / primary / delete actions.

The importer accepts only an exact `<marketPointSlug>/<Product.slug>.webp`
match. It validates every file through the existing image pipeline (WebP,
up to 5 MiB / 25 megapixels, static, complete decode) and verifies its checksum.
Validated WebP bytes are preserved: no recompression, crop, resize or watermark.

Files go to the existing `UPLOAD_DIR` (`uploads/products` relative to the API
working directory by default). URLs stay `/uploads/products/<uuid>.webp`, which
the API already serves and the storefront resolves through `useAsset()`.
The UUID is deterministic for the batch, exact product slug and source bytes,
and remains compatible with existing managed-file cleanup and order snapshots.
Source filenames stay `<slug>.webp` in the versioned pack.

Any existing image, including an invisible one, protects the product from a new
placeholder. Our already imported matching image is `UNCHANGED`; other images
are `SKIP_EXISTING`. Missing products, wrong MarketPoint associations, foreign
image links, duplicate records or conflicting destination bytes stop the batch.
Per-product locks are shared with normal admin upload. Writes never overwrite
an existing file. Dry-run writes neither files nor database rows.

## Local use

Use the existing local database containing these 146 products. Set
`DATABASE_URL` and, if needed, `UPLOAD_DIR` to the same values used by that API.
The default CLI refuses remote database hosts. Audit needs no database.

```powershell
pnpm.cmd --dir apps/api exec tsx data/product-photos/run.ts --audit
pnpm.cmd --dir apps/api exec tsx data/product-photos/run.ts --dry-run
pnpm.cmd --dir apps/api exec tsx data/product-photos/run.ts --apply
pnpm.cmd --dir apps/api exec tsx data/product-photos/run.ts --dry-run
pnpm.cmd --dir apps/api exec tsx data/product-photos/run.ts --validate
```

First dry-run/apply on products without photos: `assignedImages=146`.
Repeat: `assignedImages=0`, `created=0`, `updated=0`, `unchangedImages=146`.
Validation must report `validatedSlugImageLinks=146`, `wrongAssignments=0`.
HTTP availability is checked separately against the running local API.

## Future production use (not executed by this task)

Commit the manifest, importer and the complete WebP asset directory together.
After an approved deploy and the catalog import, use the API service's existing
environment file and service account. The deployed checkout supplies the assets;
the persistent `UPLOAD_DIR` supplies public uploads. No Windows path is required.
The existing deploy installs `tsx`; no extra dependency is needed.

From `/opt/korzinamarket`, inspect dry-run, then run apply and validate only when
production import is separately authorized:

```bash
sudo -u shop /usr/bin/node --env-file=/etc/korzinamarket/api.env \
  apps/api/node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json \
  apps/api/data/product-photos/run.ts --dry-run --allow-remote

sudo -u shop /usr/bin/node --env-file=/etc/korzinamarket/api.env \
  apps/api/node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json \
  apps/api/data/product-photos/run.ts --apply --allow-remote

sudo -u shop /usr/bin/node --env-file=/etc/korzinamarket/api.env \
  apps/api/node_modules/tsx/dist/cli.mjs --tsconfig apps/api/tsconfig.json \
  apps/api/data/product-photos/run.ts --validate --allow-remote
```

Deploy itself does not automatically import photos or overwrite real images.
