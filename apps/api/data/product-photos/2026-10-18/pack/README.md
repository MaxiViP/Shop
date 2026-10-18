# Product illustrations — 2026-10-18

AI-generated illustrations, not photographs of branded packaging. Files show the
food type on a white background. Reviewed images are stored in WebP with exact
product slugs under MarketPoint directories. The manifest contains SHA-256 hashes.
The source queue, subjects and incremental progress are in the parent directory.

Use the existing `data/product-photos/run.ts` with `--batch 2026-10-18`.
Audit and local read-only dry-run are safe preparation steps. Apply requires
separate authorization. Existing images (even hidden) are never replaced.

Visible storefront provenance comes from exact immutable importer URLs
derived from the checked manifests in `src/product/photo-origins.ts`. Editable
alt text and later product renames cannot change provenance. Rebuild that registry by running
`node data/product-photos/prepare.mjs` from the API directory after preparation.
