# Product image API — stage 3A

Read-only access to READY images from the existing [storage](product-image-storage.md)
and [offline CLI](product-image-backfill.md). No generation, publication, repair,
network fetching or directory scanning happens during HTTP requests. The API
never writes images, manifests, locks, journals or checkpoints.

## Configuration

The feature is **off by default**, including existing production configurations.
Only the exact value `PRODUCT_IMAGE_VARIANTS_ENABLED=true` enables it; absent,
`false`, `1` and other values leave it off. Configuration is read at API startup.

| Variable | Meaning |
| --- | --- |
| `UPLOAD_DIR` | Existing original root; the current upload configuration is unchanged. |
| `PRODUCT_IMAGE_VARIANTS_ENABLED` | Default `false`. |
| `PRODUCT_IMAGE_STATE_DIR` | Explicit absolute private state root; no default. |
| `PRODUCT_IMAGE_VARIANTS_DIR` | Absolute public variant root; defaults to the existing original root for the stage 2A layout. |

With a separate variant root, all three roots must be disjoint. For the original
two-root layout, source and variants may share the same root, but state must
remain outside every public root. Directories must already exist: the API does
not create them. Invalid configuration, unavailable roots and read failures
degrade to legacy images. Every directory component rejects symlinks/junctions;
root inode/device identities are pinned on first successful access. Linux also
requires the private state root to belong to the current UID and deny group/other
permissions. Windows requires an appropriately restricted ACL.

When off, enrichment performs no filesystem I/O, image JSON contains only its
existing fields, and original/hero/static URLs keep their previous behavior.
The reserved variant namespace returns `404` with `no-store`. Existing on-disk
variants and state need not be removed. The flag cannot revoke responses already
stored in browser caches.

## API contract

`GET /api/products` (including the existing cursor feeds and priority search),
`GET /api/products/:slug` and `GET /api/favorites` add optional image metadata
after their service calls finish. Authentication, filtering, visibility, image
ordering, alt text, prices, pagination and feed cursors are unchanged. Shared
`customerProduct()` stays synchronous; cart, quotes and Telegram consumers retain
their existing projections and do not perform image filesystem access.

An image without usable READY metadata stays:

```json
{ "url": "/uploads/products/550e8400-e29b-41d4-a716-446655440001.webp", "alt": "Яблоки" }
```

For a verified 960×720 original the same image can additionally contain
`width: 960`, `height: 720` and:

```json
{
  "version": "v1",
  "webp": [
    {
      "url": "/uploads/products/variants/v1/550e8400-e29b-41d4-a716-446655440001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/192.webp",
      "width": 192,
      "height": 144
    }
  ]
}
```

This object is the optional `variants` field; hash values above are illustrative.
Only verified candidates are included, sorted by actual pixel width. Private
paths, fingerprints and separate checksum fields are not returned; hashes occur
only in public immutable URLs.
An intact READY manifest must still satisfy the existing strict v1 schema,
including coverage of 192/384/640. If its physical 640 file is missing or has a
checksum mismatch, verified 192/384 candidates can still be advertised. A
hand-written partial manifest is invalid; stage 3A does not relax publication.
Unsafe paths, oversized files and failed reads invalidate the image lookup.

## Validation and bounded cache

Only canonical local managed UUID v4/v8 original URLs are accepted. Client input
never selects filesystem roots or arbitrary filenames. The registry reads
`stateRoot/ready/<uuid>.json`, validates it with the existing strict parser, and
compares the current original's SHA-256, byte length and fingerprint with READY.
Candidate byte lengths and SHA-256 hashes must match, as must actual WebP header
dimensions. The bounded header/container parser rejects animation, copied
metadata and malformed containers without invoking Sharp. Full pixel decoding
belongs to the trusted private publisher; SHA-256 ties the HTTP bytes to its
validated outputs. The API does not authenticate an attacker-controlled private
manifest writer.

The process-local LRU has at most 10,000 entries and 16 MiB of accounted metadata
(serialized key/entry bytes plus 128 bytes per entry). This is not a heap/RSS limit.
Positive TTL is 30 seconds, negative TTL 5 seconds. Buffers are not cached.
Positive hits asynchronously recheck source/manifest/candidate inode, device,
size, mtime and ctime before advertising metadata. Changed originals and missing
variants therefore invalidate hot entries before TTL expiry. Cold checks and
TTL expiry rehash bounded files. A newly available negative entry can take up to
5 seconds to become visible.

Each enrichment deduplicates up to 512 unique image URLs and clones metadata for
each output image. Simultaneous lookups of the same URL share a promise. At most
four read operations run concurrently, with at most 256 pending unique lookups
and 256 queued operations. Excess work returns legacy images. File bounds are
16 KiB per manifest, 5 MiB per original and 2 MiB per candidate. No synchronous
filesystem reads or recursive enumeration are used by the registry.

## HTTP namespace and fallback

The handler is installed before the existing `/uploads/products/` static
middleware and outside the `/api` prefix:

```text
/uploads/products/variants/v1/<uuid>/<source-sha256>/<bound>[-<output-sha256>].webp
```

`bound` is exactly 192, 384 or 640. Hash-suffixed repair URLs use the existing
storage protocol. Only exact canonical URLs listed in the current valid READY
manifest can return image bytes. The handler reserves decoded/normalized/Unicode
case aliases and Win32 trailing-dot/space aliases of this namespace as well,
then rejects noncanonical URLs, queries, traversal and symlink escapes instead
of falling through to generic static
serving. Private manifests, journals and temporary files are not routable.

Verified `GET` and `HEAD` responses use `Content-Type: image/webp`,
`X-Content-Type-Options: nosniff`, a strong SHA-256 ETag, Last-Modified and
`Cache-Control: public, max-age=31536000, immutable`. Conditional requests use
Express freshness handling, including weak/wildcard If-None-Match, precedence
over If-Modified-Since and `304`/HEAD with no body. Each variant request rechecks
the bounded body checksum and dimensions, even for a conditional request.

If an advertised file disappears, changes or loses its READY/source match, the
handler returns an empty `307` to its canonical original URL, only after checking
that the original is a safe regular file. Redirects carry `no-store` and no ETag,
Last-Modified or immutable header; the original retains its existing static
headers. An absent/unsafe original or invalid URL returns `404 no-store`. Other
methods return `405` with `Allow: GET, HEAD` for canonical variant URLs. No
generation or repair is attempted.

## Verification and filesystem limits

Targeted checks from the repository root (use `pnpm.cmd` in PowerShell when
script execution policy blocks `pnpm.ps1`):

```sh
pnpm --filter api exec vitest run src/product src/favorite src/admin/privacy.spec.ts src/admin/images.spec.ts src/order/cart-quote.spec.ts data/product-image-variants/backfill.spec.ts test/product-images.spec.ts --no-file-parallelism
pnpm --filter api typecheck
pnpm lint
pnpm build
git diff --check
```

`image-registry.spec.ts` covers malformed/missing/changed inputs, partial physical
sets, deduplication, TTL/LRU/byte limits, bounded concurrency, I/O errors, root
replacement and path/symlink checks. `image-webp.spec.ts` covers container/header
validation. `image-static.spec.ts` exercises a real Nest HTTP server and static
middleware with GET/HEAD/conditional/cache/fallback checks and private storage
denial. `test/product-images.spec.ts` exercises real controllers, guards and
product/favorite services with a mocked DB; it checks enrichment after
transactions and the exact legacy structure with the flag off. Tests use
isolated OS temp roots, compare tree hashes/mtimes before/after reads and assert
that HTTP/registry operations never invoke Sharp.

The tests require no PostgreSQL connection. Existing DB E2E fixtures that build
controllers manually receive a disabled registry; their business assertions are
unchanged. DB-backed E2E is a separate check and is not implied by these mock-DB
HTTP tests.

Windows junction tests run locally. Native file symlink tests are Linux-only
because Windows may require symlink privileges. Existing storage/backfill
Linux-only permission and fsync checks remain Linux-only and must run on Linux
before production integration. Linux uses `O_NOFOLLOW` for file opens; Windows
uses the existing lstat/realpath/handle identity checks. Ancestors and roots must
remain controlled by a trusted OS user/ACL. Node's portable path APIs cannot
provide a general `openat2`-style guarantee against a privileged concurrent
directory replacement; this API does not broaden the storage trust boundary.
Manifests bind to the current original's filesystem fingerprint, so copying
images/manifests between hosts or filesystems can invalidate READY metadata.
HTTP requests never republish or repair it.

No Nginx, frontend, Prisma, migrations, production storage or deployment changes
are included. Production integration and frontend adoption require a separately
agreed stage.
