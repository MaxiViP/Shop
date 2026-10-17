# Local-only read-only launcher FD handoff (candidate)

This change passes the root-opened, root-owned mode-0600 `/input/request.json`
file descriptor from the **broker-backed** launcher to its unprivileged Node
child **only for `--dry-run`**. Node validates Linux uid/gid/groups,
seccomp/NNP/capability restrictions, FD identity and fixed input roots, exact
`image-sandbox-inspection` request kind, batch/approval scope and service cgroup.
The return value remains `status: inspection-only` and grants no privileges.

`run.ts --apply` **always** calls `requireProductionSandbox()` before any
inspection; neither this handoff nor the earlier `inspectLauncherAdmission`
function is a production authorization. `environment.ts`, the systemd units,
`launcher`'s final exit code **78**, hard resource limits, and the FDSTORE deploy
fence behavior are unchanged. No writes to real image variant/state roots are
performed by this patch. The legacy non-broker dry-run remains unchanged.

## Verify locally (no VPS)

```bash
cd ~/Shop
pnpm --dir apps/api typecheck
pnpm --dir apps/api lint
cd apps/api
node --import tsx --test data/product-image-production/admission.spec.ts
cd ../..
python -m py_compile deploy/image-runner/launcher.py
```

Positive handoff and prior lifecycle evidence must be reverified using the
**existing disposable Linux/systemd VM fixture**, never by installing or
running on the production VPS. The unit still advertises inspection-only and
exits nonzero. A successful Linux dry-run proof is not enough to enable apply:
reverse `/proc` isolation, request/approval provenance, correct unit pinning,
artifact hashes, fuse/bind behavior, rollback and recovery, off-VPS backups,
`nobarrier` durability, and production operational approval remain blockers.
