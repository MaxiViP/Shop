/**
 * Read-only candidate for verifying an inherited, root-opened launcher request.
 * This is NOT an apply authorization. No production writer uses its result.
 *
 * The request FD is one kernel identity check, not a replacement for the
 * launcher/cgroup/fence/recovery acceptance. In particular, host processes
 * running as shop may be able to inspect same-UID workers via /proc until the
 * reverse API->worker isolation is separately proven.
 */
import { readSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { RunnerError } from './model.js';
import type { Options } from './options.js';

const REFUSED = 'SANDBOX_UNVERIFIED';
const STATUS_FIELDS = ['CapEff', 'CapPrm', 'CapInh', 'CapAmb'] as const;
const BOUNDING_CAPABILITIES = 0xe4n;
const MAX_REQUEST = 8192;

function refuse(): never {
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
  if (fields.get('NoNewPrivs') !== '1' || fields.get('Seccomp') !== '2') return false;
  try {
    return STATUS_FIELDS.every((key) => BigInt(`0x${fields.get(key)}`) === 0n) &&
      BigInt(`0x${fields.get('CapBnd')}`) === BOUNDING_CAPABILITIES;
  } catch {
    return false;
  }
}

/**
 * This inspector MUST NOT be used as a boolean/env/CLI bypass of --apply.
 * A successful read-only inspection remains non-authorizing by contract.
 * All paths here are systemd-owned constants, never user-selected.
 */
type InspectKind = 'image-production-apply' | 'image-sandbox-inspection';

function inspectHandoff(options: Options, kind: InspectKind): Readonly<{
  status: 'inspection-only';
  runId: string;
}> {
  if (process.platform !== 'linux' || process.getuid?.() !== 997 ||
      process.getgid?.() === 0 || process.getgroups?.().length !== 0 ||
      process.env.NODE_ENV !== 'production') refuse();
  if (options.sourceRoot !== '/storage/products' ||
      options.variantsRoot !== '/storage/product-variants' ||
      options.stateRoot !== '/storage/.product-image-state' ||
      options.inventory !== '/input/inventory.jsonl' ||
      options.approval !== '/input/approval.json' ||
      !options.approvalSha256 ||
      options.apply !== (kind === 'image-production-apply')) refuse();
  if (!kernelPolicy(readFileSync('/proc/self/status', 'utf8'))) refuse();

  // A number supplied through the environment is NOT itself a credential.
  // The fd must refer to the *same* root-owned 0600 regular inode that systemd
  // bound into the namespace, which an unprivileged shop process cannot open.
  const rawFd = process.env.KORZINA_IMAGE_ADMISSION_FD;
  if (!rawFd || !/^[3-9][0-9]?$/.test(rawFd)) refuse();
  const fd = Number(rawFd);
  let before: BigIntStats;
  let opened: BigIntStats;
  try {
    before = lstatSync('/input/request.json', { bigint: true });
    opened = fstatSync(fd, { bigint: true });
    if (!checkedFile(before) || !sameFile(before, opened)) refuse();
  } catch {
    refuse();
  }

  // Positional reads do not consume or change the inherited descriptor offset.
  const bytes = Buffer.alloc(MAX_REQUEST + 1);
  let size: number;
  try {
    size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== Number(before.size)) refuse();
    const after = lstatSync('/input/request.json', { bigint: true });
    if (!sameFile(before, after) || !sameFile(opened, fstatSync(fd, { bigint: true })))
      refuse();
  } catch {
    refuse();
  }
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) refuse();
    request = parsed as Record<string, unknown>;
  } catch {
    refuse();
  }
  // Bind to the exact inspector-only or future apply request kind; neither
  // return value authorizes a production write.
  if (request.kind !== kind || request.schemaVersion !== 1 ||
      typeof request.runId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.runId) ||
      request.approvalSha256 !== options.approvalSha256 ||
      request.batchSize !== options.batchSize) refuse();

  const cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim();
  if (cgroup !== `0::/system.slice/shop-image-runner@${request.runId}.service`) refuse();
  return Object.freeze({ status: 'inspection-only', runId: request.runId });
}

/**
 * Verifies the existing inspection-only launcher FD handoff. NEVER authorizes
 * writes, even if all kernel and request identity checks succeed.
 */
export function inspectLauncherDryRunHandoff(options: Options): Readonly<{
  status: 'inspection-only';
  runId: string;
}> {
  return inspectHandoff(options, 'image-sandbox-inspection');
}

/** Retained as a non-authorizing candidate for a future separately approved apply protocol. */
export function inspectLauncherAdmission(options: Options): Readonly<{
  status: 'inspection-only';
  runId: string;
}> {
  return inspectHandoff(options, 'image-production-apply');
}
