# Product image storage — stage 2A

Standalone filesystem support for the stage 1 generator, also used by the
[offline stage 2B CLI](product-image-backfill.md). No upload, API, database,
frontend or background worker integration is enabled.

## Contract

`ImageStorage.open({ publicRoot, stateRoot })` requires explicit, existing absolute
directories on the same local filesystem. It performs validation without writes.
There are no environment-dependent or production defaults. The roots cannot
overlap. Source URLs accept only exact lowercase managed UUID v4/v8 WebP paths;
external URLs, query strings, encoded separators, traversal and alternate streams
are rejected. Roots and every directory component are checked with `lstat`; the
complete directory is checked with `realpath`. Root inode/device identity is
checked again during operations. Symlinks and Windows junctions are rejected.

Stage 2B adds an optional explicit `sourceRoot`. When provided, source, public
variant and private state roots must all be disjoint; sources are read exclusively
from `sourceRoot`, without copying/linking originals into `publicRoot`. With the
option omitted, the stage 2A two-root contract remains supported. Only state and
public variant roots need to share a device for hard-link publication.

`version(url)` returns a bounded read-only source checksum/fingerprint snapshot.
`inspect(url)` performs full source/ready validation without generation or writes.
`save(url, encoder, expectedVersion)` checks a frozen backfill source version
under the existing source lock before encoding/publication. The original writer,
repair URLs and no-clobber protocol are reused.

`save(sourceUrl, encoder?)` processes one source under an exclusive per-source
writer lock. The optional encoder accepts a bounded source buffer and returns the
existing `ImageVariants` type; a future supervised generator can use this seam.
Output reports are independently checked against source metadata and staged bytes.
`readReady(sourceUrl)` returns a manifest only after checking source fingerprint,
SHA-256 and all candidate files, including a full Sharp decode. It returns `null`
for missing/corrupt/stale content and throws sanitized errors for unsafe paths or
I/O failures. This expensive verifier is for jobs/recovery, not HTTP GET handlers.
Future API enrichment needs its own bounded registry reader.

```text
publicRoot/
  <uuid>.webp                         existing source, read only
  variants/v1/<uuid>/<sourceSha256>/
    192.webp                         bounding size, actual dimensions in manifest
    384.webp
    640.webp
    192-<outputSha256>.webp           possible immutable repair revision
stateRoot/                           outside the entire public static root
  locks/<uuid>.lock                  exclusive writer, owner token/host/PID
  work/<uuid>/<attemptUuid>/         private staging
  ready/<uuid>.json                  strict, versioned, at most 16 KiB
```

Tiny sources can share one physical output through its `sizes` array. A ready
manifest describes the complete 192/384/640 set, with actual width/height, byte
count, SHA-256, source fingerprint and fixed v1 encoding parameters. It contains
no absolute paths. File reads are bounded even if a file grows after `stat`.

## Publication and recovery

1. Open the writer lock with `O_CREAT | O_EXCL`; never steal a lock by age.
2. Read/validate the source without writing it. A fully verified ready set returns
   `UNCHANGED` without calling the encoder or writing its files/manifest.
3. Generate in memory. Write outputs only in private staging with exclusive create,
   mode 0600, `FileHandle.sync()` and close. Read back, hash and fully decode them.
4. Publish a complete file using `link(temp, destination)`. This creates a new
   directory entry without replacement. `EEXIST` requires verifying the winner;
   there is no copy-to-public, truncate, unlink-destination or rename fallback.
5. Keep correct existing variants unchanged. A conflicting/corrupt canonical file
   is preserved and reported in `conflicts`; publish the intended bytes under the
   deterministic checksum repair URL. A conflicting repair URL stops the job.
6. Verify every final candidate. Write/fsync/read back the private temporary
   manifest, then recheck all final candidates, the source snapshot and lock
   ownership before atomically replacing only the private ready JSON using
   `rename`. Checking the source after the final variant decodes catches a source
   replaced during those decodes. Never remove an old manifest to work around a
   failed Windows rename.

An interrupted call never writes/deletes an original. Published variants without
a ready manifest are not ready. A retry checks existing bytes and reuses correct
files with unchanged inode/mtime. Partial recovery currently encodes the small
complete set again in memory, but writes only missing/new revision files. A corrupt
existing manifest is ignored and rebuilt from verified outputs. A physical ready
file is not proof of readiness: consumers must use the verifier/validated reader.

Ordinary errors release only the owned lock. Failed attempts retain private work
for diagnosis; there is no recursive cleanup/GC. A kill/power loss can leave a lock.
Unknown owner locks always fail closed. Automated stale-lock recovery, proving
owner process death/start identity and cleaning only owned attempts, belongs to
the future supervisor/operator workflow; PID or elapsed time alone is insufficient.

## Windows and Linux boundaries

- Windows: native Node hard links and replacement of private metadata are tested
  on the local filesystem. Junction tests need no file-symlink privilege. Node
  provides neither POSIX `O_NOFOLLOW` nor directory fsync on Windows; these are
  not emulated. File data is synced, but power-loss directory-entry durability is
  not guaranteed. ACLs must be provisioned by the operator; POSIX modes do not
  enforce Windows privacy. Worker/API identities must be able to read published
  hard-linked files, which retain their original security descriptor.
- Linux: actual `O_NOFOLLOW`, `O_NONBLOCK`, `O_DIRECTORY`, file fsync and directory
  fsync are used. Directory sync failures propagate. State root must be owned by
  the current UID with no group/other access; private dirs/files use 0700/0600.
  Two Linux-only tests exercise native flags, modes and source-file symlinks; they
  are explicitly skipped on Windows, without changing `process.platform` or
  substituting Windows primitives for POSIX semantics.
- Supported deployment requires a trusted local filesystem with native hard links
  and atomic metadata rename, and pre-provisioned trusted owners/ACLs for roots
  and ancestors. Network filesystems/mapped network drives are outside this
  contract. Cross-device roots and Windows UNC/device paths are rejected; there
  is no automatic certification of every filesystem implementation. Link failure
  fails closed. Test the intended Linux mount before operational use.
- Portable Node path checks are not a capability sandbox against a hostile process
  concurrently swapping parent directories. Deny untrusted writers to roots and
  ancestors; do not treat `lstat` checks as an `openat2`/Windows reparse-point API.
- The storage layer itself has no total RSS limit, hard job deadline, free-space admission, retry journal,
  inventory/limit/resume CLI or automatic stale-lock recovery is implemented here.
  These are required around this storage layer for a bounded backfill. Filesystem
  correctness tests do not certify resilience to actual power loss.

All automated fixtures and fault-injection writes use guarded OS temp directories.
Tests wrap native I/O for failure injection; successful filesystem operations are
real. The original generator and repository photo pack are unchanged by stage 2A.

## Resumed verification — 2026-10-15

The interrupted session left the four storage/manifest TypeScript files and this
document untracked on `feat/product-image-variants-generator`, after `f46137b`.
The Vitest cache was newer than those files and marked all three image suites
successful; the backend build predated the last storage changes. No conclusive
typecheck/lint result for those changes was retained.

Review reproduced one source-change race: replacement during the last variant
verification could return `READY` for the previous source. The regression failed
before the fix and passed after moving the final source check after those
verifications. Existing storage behavior and the stage 1 generator were preserved.

Verified with Node 24.20.0 and pnpm 11.24.0 on Windows:

- Focused Vitest run: `image-variants.spec.ts`, `image-storage.spec.ts` and
  `image-manifest.spec.ts` — 130 passed, 2 Linux-only tests skipped, 0 failed.
- `pnpm --filter api typecheck` — passed after the fix.
- `pnpm lint` — all three workspace packages passed; API lint passed again after
  the fix.
- `pnpm build` — API and gateway passed. The frontend stopped on sandbox
  `EPERM: readlink C:\Users\batti`; `pnpm --filter web build` passed outside the
  sandbox. API build passed again after the fix.
- `git diff --check` and `git diff --cached --check` — passed before commit.

Linux-native tests, real process-kill/power-loss recovery and the intended Linux
mount have not been exercised in this Windows run. No production paths, migrations,
backfill, API integration or deployment were used.
