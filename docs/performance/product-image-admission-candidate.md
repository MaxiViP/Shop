# WebP: candidate admission inspection (local only)

This patch adds **only a read-only inspection candidate**, not production
`--apply`. Current `run.ts`, `runner.ts`, `launcher.py`, systemd units and
`environment.ts` are intentionally unchanged. The CLI still rejects every
ordinary direct `--apply` with `SANDBOX_UNVERIFIED`.

The candidate verifies Linux identity, zero effective/permitted/inheritable/
ambient capabilities, expected bounded capabilities, seccomp+NNP, immutable
paths, and a request file descriptor opened by the root launcher. The FD must
match the root-owned mode-0600 `/input/request.json` inode, and its exact run
scope must correspond to the fixed runner service cgroup.

**Not a sufficient authorization design yet:** a kernel FD identity check alone
is not proof of an acceptable root-launcher admission protocol. A host-side
same-UID API might be able to duplicate a worker's inherited descriptor via
`/proc`, and no evidence currently closes that reverse direction on target.
Root-owned request provisioning, full approval provenance, inherited FD
lifetime/SCM transfer, deploy fence retention across descendants, mount/link
acceptance, crash/recovery, storage durability (`nobarrier`), backup/restore,
artifact immutability and systemd broker lifecycle still require review and
end-to-end native acceptance. Do not enable production writes by simply
replacing `requireProductionSandbox` with this inspector.

To run the two negative unit tests in the local checkout:

```bash
cd apps/api
node --import tsx --test data/product-image-production/admission.spec.ts
```

No VPS or production changes are part of this patch.
