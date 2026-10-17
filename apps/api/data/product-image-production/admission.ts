/** Kernel/FD admission for the fixed root supervisor, never an env attestation.
 * The supervisor verifies mounts, resources, immutable inputs, manager identity
 * and the retained deployment fence before opening this root-only descriptor.
 * API and runner use private PID namespaces; Node never inherits the manager bus.
 */
import { readSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { RunnerError } from './model.js';
import type { Options } from './options.js';

const REFUSED = 'SANDBOX_UNVERIFIED';
const STATUS_FIELDS = ['CapEff', 'CapPrm', 'CapInh', 'CapAmb'] as const;
const BOUNDING_CAPABILITIES = 0xe4n;
const MAX_REQUEST = 8192;

// A fixed, non-sensitive stage marker is emitted only on an admission refusal.
// It is NOT an attestation, credential, or authorization to write.
function refuse(stage?: string): never {
  if (stage && process.env.KORZINA_IMAGE_ADMISSION_FD !== undefined &&
      process.env.NODE_ENV === 'production')
    console.error(`ADMISSION_STAGE=${stage}`);
  throw new RunnerError(REFUSED);
}

function checkedFile(info: BigIntStats): boolean {
  return (
    info.isFile() && !info.isSymbolicLink() && info.uid === 0n &&
    info.gid === 0n && info.nlink === 1n &&
    (info.mode & 0o777n) === 0o600n &&
    info.size > 0n && info.size <= BigInt(MAX_REQUEST)
  );
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs;
}

function kernelPolicy(status: string): boolean {
  const fields = new Map(
    status.split('\n').filter((line) => line.includes(':')).map((line) => {
      const separator = line.indexOf(':');
      return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
    }),
  );
  // Node.js process.getgroups() always includes the effective GID; unlike
  // the Linux kernel Groups: field, it cannot prove zero supplementary groups.
  if (fields.get('Groups') !== '' ||
      fields.get('NoNewPrivs') !== '1' || fields.get('Seccomp') !== '2') return false;
  try {
    return STATUS_FIELDS.every((key) => BigInt(`0x${fields.get(key)}`) === 0n) &&
      BigInt(`0x${fields.get('CapBnd')}`) === BOUNDING_CAPABILITIES;
  } catch {
    return false;
  }
}

/** Bind the primary group to root-owned local NSS data, not a host-specific GID.
 * The disposable VM uses shop:997:55001; the inspected VPS uses shop:997:981.
 * The root supervisor independently verifies the shop account before exec.
 */
function shopPrimaryGid(): number {
  try {
    const file = lstatSync('/etc/passwd', { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== 0n ||
        (file.mode & 0o022n) !== 0n || file.size < 1n || file.size > 1024n * 1024n) refuse();
    const matches = readFileSync('/etc/passwd', 'utf8').split('\n').filter((line) => line.startsWith('shop:'));
    if (matches.length !== 1) refuse();
    const fields = matches[0]!.split(':');
    if (fields.length !== 7 || fields[0] !== 'shop' || fields[2] !== '997' ||
        !/^[1-9][0-9]{0,9}$/.test(fields[3] ?? '')) refuse();
    const gid = Number(fields[3]);
    if (!Number.isSafeInteger(gid) || gid > 0xffff_ffff) refuse();
    return gid;
  } catch {
    refuse('NSS');
  }
}

/**
 * The request kind binds dry-run and production apply to distinct root requests.
 * All paths here are systemd-owned constants, never user-selected.
 */
type InspectKind = 'image-production-apply' | 'image-sandbox-inspection';

function inspectHandoff(options: Options, kind: InspectKind): Readonly<{
  runId: string;
}> {
  if (process.platform !== 'linux' || process.getuid?.() !== 997 ||
      process.geteuid?.() !== 997 || process.env.NODE_ENV !== 'production') refuse('IDENTITY');
  const gid = shopPrimaryGid();
  if (process.getgid?.() !== gid || process.getegid?.() !== gid) refuse('GROUP_ID');
  if (options.sourceRoot !== '/storage/products' ||
      options.variantsRoot !== '/storage/product-variants' ||
      options.stateRoot !== '/storage/.product-image-state' ||
      options.inventory !== '/input/inventory.jsonl' ||
      options.approval !== '/input/approval.json' ||
      !options.approvalSha256 ||
      options.apply !== (kind === 'image-production-apply')) refuse('OPTIONS');
  let status: string;
  try { status = readFileSync('/proc/self/status', 'utf8'); }
  catch { refuse('KERNEL_STATUS'); }
  if (!kernelPolicy(status)) refuse('KERNEL_POLICY');

  // A number supplied through the environment is NOT itself a credential.
  // The fd must refer to the *same* root-owned 0600 regular inode that systemd
  // bound into the namespace, which an unprivileged shop process cannot open.
  const rawFd = process.env.KORZINA_IMAGE_ADMISSION_FD;
  if (!rawFd || !/^(?:[3-9]|[1-9][0-9])$/.test(rawFd)) refuse('FD_NUMBER');
  const fd = Number(rawFd);
  let before: BigIntStats;
  let opened: BigIntStats;
  try {
    before = lstatSync('/input/request.json', { bigint: true });
    opened = fstatSync(fd, { bigint: true });
    if (!checkedFile(before) || !sameFile(before, opened)) refuse('FD_INODE');
  } catch {
    refuse('FD_INODE');
  }

  // Positional reads do not consume or change the inherited descriptor offset.
  const bytes = Buffer.alloc(MAX_REQUEST + 1);
  let size: number;
  try {
    size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== Number(before.size)) refuse('FD_READ');
    const after = lstatSync('/input/request.json', { bigint: true });
    if (!sameFile(before, after) || !sameFile(opened, fstatSync(fd, { bigint: true })))
      refuse('FD_READ');
  } catch {
    refuse('FD_READ');
  }
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) refuse('REQUEST_JSON');
    request = parsed as Record<string, unknown>;
  } catch {
    refuse('REQUEST_JSON');
  }
  // A root inspection request can never be replayed as production apply.
  if (request.kind !== kind || request.schemaVersion !== 1 ||
      typeof request.runId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.runId) ||
      request.approvalSha256 !== options.approvalSha256 ||
      request.batchSize !== options.batchSize) refuse('REQUEST_BINDING');

  let cgroup: string;
  try { cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim(); }
  catch { refuse('CGROUP_STATUS'); }
  if (cgroup !== `0::/system.slice/shop-image-runner@${request.runId}.service`) refuse('CGROUP_PATH');
  return Object.freeze({ runId: request.runId });
}

/**
 * Verifies the existing inspection-only launcher FD handoff. NEVER authorizes
 * writes, even if all kernel and request identity checks succeed.
 */
export function inspectLauncherDryRunHandoff(options: Options): Readonly<{
  status: 'inspection-only';
  runId: string;
}> {
  return Object.freeze({ status: 'inspection-only', ...inspectHandoff(options, 'image-sandbox-inspection') });
}

/** Production admission; called again before publication and each checkpoint. */
export function inspectLauncherAdmission(options: Options): Readonly<{
  status: 'verified';
  runId: string;
}> {
  return Object.freeze({ status: 'verified', ...inspectHandoff(options, 'image-production-apply') });
}
