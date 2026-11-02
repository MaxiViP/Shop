# Image prepare incident: recovery runbook

Status: procedure for later, separately authorized production maintenance. Nothing
in this document has been executed on production. No merge, deploy, batch,
service stop, unit replacement, reset-failed or storage cleanup is authorized by
this change. Counts below are incident observations, not live preconditions.

## Why the runner stopped

At the reported snapshot, products contained 216 canonical UUID.webp files and
`telegram/` (root:root, 0755, one 61976-byte JPG). `prepare.ts` passed every name
to `productImageId`, so the directory caused ImageManifestError before discovery.
`launcher.storage_policy` would independently refuse that same directory at
apply admission. Three inspected units had this error; this does not establish
the error of all 981 failed units.

The old manager created three `{}` newline files under a random prepare UUID
before systemd start. Its finally block only removed them and the unit file when
the entire batch succeeded. Every failed prepare therefore retained both a
placeholder and a failed systemd unit. 982 placeholders + 19 filled requests =
1001 entries; the bounded request scan then refused CONTROL_LIMIT. A failed
prepare unit and an empty request need not have a one-to-one mapping (981 vs
982), so neither list may be inferred from the other.

The fix permits exactly the known Telegram directory, never traverses it, and
retains the allowlist for all other source entries. It requires root:root 0755,
no xattrs/ACLs, no symlink, the source filesystem, and no nested source mounts.
Both prepare and apply validate Python storage policy; Node discovery also
checks the exact directory and canonical regular single-link files. Encoding
still revalidates source snapshots. No Telegram files, product paths, HTTP
routes, prices or database schema change.

Prepare units now omit the three apply input binds and the broker bind. They
need no placeholder and have no FD store. Their unit bytes, final manager state
and JSON journal are fsynced with SHA256 evidence under
`/var/lib/korzinamarket-image-runner/preparations/<prepare-id>/` before an
exact failed-unit reset and unlink/reload. A completed inactive unit is not
stopped or reset: systemd may already have collected it. Cleanup refuses if
quiescence, unit integrity
or evidence persistence is unproven. SIGKILL of the operator can still leave an
orphan unit/evidence directory; it cannot create a placeholder. Such orphans
require the reviewed recovery process below, never a time-based GC. Evidence
has no automatic retention deletion; monitor disk and archive it separately.
CONTROL_LIMIT remains 1000, now reserving room for one real apply request. No
old request is deleted by a new batch. The existing admin flock serializes
operators, and the deployment fence is closed on all early failures, including
CONTROL_LIMIT. Apply FDSTORE, pins and source/run locks retain their rules.

## Telegram provenance and consumers

The creating process, creation time and intended lifetime of the production
Telegram directory cannot be established from the supplied stat facts. root
ownership does not prove an obsolete artifact: a root-run import, old deployment,
manual script, copy/restore or external integration could create the same tree.
Local tracked source/history searches found no demonstrated creator for this
exact on-disk directory. That is an unresolved provenance finding, not proof of
no consumers.

Both local `8b1062c` and tracked production revision `b676aed` use
`configureProductImageHttp` to serve nested files under productUploadRoot,
so `/uploads/products/telegram/<actual-basename>.jpg` remains a valid public
static URL, including HEAD. A new HTTP regression preserves that behavior.
Current Telegram photo.ts and catalog-photo.ts generate JPEG derivatives in
memory. Chat images are separately stored under uploads/chat. Neither implies
that previous messages, Bot API file IDs/caches, DB values or external clients
stopped referring to the existing public JPG.

Before any future proposal to move/remove Telegram media, perform separately
authorized read-only investigation of the running b676aed artifact as well as
8b1062c: systemd/PM2 ExecStart and resolved current release, root/owner cron and
timers, deployed scripts and untracked release files, import/backup/restore
records, proxy/static aliases, actual nonsecret storage configuration, filesystem
birth/ctime/mtime and available audit records. Do not print environment values or
bot tokens. Search exact relative/absolute/percent-encoded public URLs and exact
basename in restricted DB extracts (ProductImage.url, photo URLs, persisted
Telegram/session/outbox payloads and other text/JSON references), access logs,
archived messages and integration inventories. Zero DB/log matches do not cover
expired retention, third parties, Telegram caches or previously sent URLs.
Retain existing Telegram media irrespective of whether provenance is resolved.

## Gate A: evidence and owner classification (read-only production work)

An operator must explicitly authorize collection and protect its output as
potential customer data. Use a new private incident directory outside requests
and uploads; never add raw production evidence to Git. Record UTC, boot ID,
running release, tool hashes and all source paths. Export a metadata-preserving
snapshot/backup and independently verify restore/checksums before cleanup.

Record all 1001 request entries, all 981 failed prepare units and any additional
units discovered, including missing counterparts. For every filesystem entry
record absolute path, lstat type, dev/inode, uid/gid, mode, nlink, size,
mtime/ctime/birth time where available, ACL/xattrs, realpath and SHA256 of regular
files opened O_NOFOLLOW with pre/post inode/size/time checks. Record directory
membership too. Do not follow symlinks or unknown mounts. Export unit fragments
and drop-ins, `systemctl show` state (including InvocationID, FragmentPath,
DropInPaths, MainPID, ExecMainPID, ControlGroup, Result, ExecMainStatus,
ActiveState, SubState, NRestarts, NFileDescriptorStore and jobs), and full JSON
journals per exact unit/invocation. Archive the original journal interval as well
as its checksums. Preserve the cursor, manifest, rootfs identity and installed
manager/launcher/broker/prepare code hashes. Record checksums and metadata for all
216 originals and Telegram directory/JPG without changing them.

Produce a reviewed, checksummed JSON ledger with independent lists:

- 982 candidate placeholders: canonical UUID directory, root-owned private
  directory; exactly request.json, inventory.jsonl, approval.json; all regular,
  root-owned, private, one link, exact bytes `{}` + LF (3 bytes); no extra entries,
  symlink, ACL, mount, broker binding or filled approval. Check deployed-version
  semantics and map creator/invocation from logs. Missing ownership evidence =>
  UNKNOWN, not eligible. Do not classify merely by length or empty JSON parsing.
- 981 candidate failed prepares: exact `shop-image-prepare-<UUID>.service`,
  fragment/invocation matching the old generated prepare command and sandbox;
  never an apply runner, pin, broker or unrelated service. Classify actual error
  from each journal. Missing/ambiguous evidence => UNKNOWN.
- 19 filled or partial real requests: PRESERVE in place with all their approval,
  inventory, broker identity, state and journals. Never automatically clean them,
  even when apparently finished. Unknown entries, partial requests and the
  unmatched placeholder remain held for owner review.

The numerical counts are cross-checks only. A mismatch stops the procedure for
review; it must never expand an allowlist. Bind the approved ledger to its
snapshot checksum and explicit per-entry owner decision.

## Gate B: quiescence and serialization

Inventory pending systemd jobs, all prepare/apply/pin/broker units, relevant
cgroups and processes in their namespaces, timers/cron/CI/manual operators and
open descriptors to requests/storage. Confirm absence of active operations twice,
then serialize under the existing image admin lock and acquire the existing
deployment fence nonblocking without recreating/truncating/unlinking it. A busy
fence stops recovery. Do not release another operation's retained FDSTORE or pin.
For every candidate unit require inactive/failed, MainPID=0, NRestarts=0,
NFileDescriptorStore=0, no queued job and the expected system.slice cgroup absent
or both populated 0 and empty cgroup.procs. Recheck while locks are held.

Never infer safety solely from an old PID, a successful `ps`, timeout or absence
of a visible runner. An active or uncertain object is left untouched; this
procedure does not stop services to make the gate pass. Record lock inodes and
all image/run lock contents before/after; never unlink or replace any lock.

## Gate C: separately approved mutation, two independent operations

After A and B, present the exact allowlists, snapshots/checksums and rollback
locations for approval. Do not run a wildcard reset, recursive deletion, migrate
reset or a batch as part of cleanup.

Use a durable private evidence directory such as
`/var/lib/korzinamarket-image-recovery/<incident>/evidence`, a request quarantine
at `/var/lib/korzinamarket-image-runner/recovery/<incident>/requests`, and a
runtime-fragment quarantine at `/run/korzina-image-recovery/<incident>/units`.
Verify actual mount IDs and dev numbers before selecting these locations. The
runtime quarantine is volatile; its verified durable evidence copy is required
for rollback after reboot. No cross-filesystem move or destination overwrite is
allowed. The approved ledger contains all absolute source and destination paths.

1. **Failed-unit operation (up to 981, per reviewed ledger).** Revalidate each
   exact fragment's inode/hash and quiescence. Copy the fragment/drop-ins and
   verify the archive. Reset failed state for only that reviewed prepare unit,
   quarantine its exact runtime fragment under the incident directory on the
   same filesystem, and reload the manager only in the approved window. Check
   that the exact unit unloads and that no apply/pin/broker state or FD store
   changed. Do not stop anything; any newly active object aborts the operation.
   Preserve journald exports before reset. Unknown or missing fragment stays
   pending classification. Do not remove persistent template files.
2. **Placeholder operation (up to 982, independent ledger).** Revalidate every
   directory and all three files against snapshot identity, metadata and hashes;
   ensure there is no unit, job, broker or real request binding referring to it.
   Quarantine each whole directory with a same-filesystem rename into a private
   root-owned sibling of requests (outside the counted namespace), without
   overwriting any destination. fsync both parents and append/fsync a move
   receipt. Do not recursively delete it. A source missing with an identical
   verified quarantine destination and committed receipt is already complete;
   an unexpected absence, changed source, existing destination or partial receipt
   requires reconciliation, not deletion or overwrite. Keep all 19 filled
   requests in place. Recount requests after each reviewed chunk.

Recovery is resumable from per-entry receipts, never by rescanning and deleting
whatever looks empty. Journal reset cannot be reversed, which is why the
verified export is mandatory. Quarantine has a retention period and separate
future deletion approval. Do not introduce an automatic recovery command into
the production manager. The new manager does not adopt old requests or units.

## Rollback and validation

On any mismatch stop processing and retain locks until the operator records
quiescence. Under the same gates, reverse only recorded renames with matching
quarantine metadata/hash, absent original destinations and no active references.
Restore archived unit fragments only after review; daemon-reload does not rerun
an old prepare, and reset-failed state is represented by its saved evidence.
Do not replay filled approvals or remove READY/state/variants to obtain a green
result. A software rollback restores the preceding immutable artifact and matching
host tools as one reviewed change, preserving all storage and requests. Returning
to old code will again refuse Telegram; keep batches disabled rather than changing
Telegram to accommodate that rollback.

After separately approved code installation, verify hashes of host tools,
rootfs/manifest, both templates and source identity against the tested artifact.
Read-only checks must show Telegram metadata/JPG SHA256 unchanged, all originals
unchanged, 19 filled requests byte-for-byte intact, no changed locks/fences,
expected request count below CONTROL_LIMIT, no new failed prepare units and
existing Telegram JPG GET/HEAD and representative catalog pages still working.
A test-environment HTTP check does not prove production routing or Telegram
interaction; verify those separately with the store owner.

Only with separate batch permission, select one existing canonical UUID.webp
with approved original SHA256 and run exactly `manage.py batch --size 1 --image
<UUID.webp>` from the verified installation. Validate returned approval/runId,
source hash, READY manifest, real Sharp/WebP decode and expected 192/384/640
widths (for a sufficiently large original), checksum/size/MIME, HTTP GET/HEAD
and fallback, no changes to originals/Telegram, no leftover prepare unit or
placeholder, archived prepare evidence, and fence release only after runner
quiescence. Repeating that exact canary must make no additional image writes.
Do not start a wider batch automatically. Any failure retains apply evidence and
FDSTORE/locks for separate review; no force-unlock. This PR neither merges nor
deploys and performs none of these production actions.
