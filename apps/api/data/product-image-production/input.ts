import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { IMAGE_VARIANT_PROFILES } from '../../src/product/image-variants.js';
import { productImageId } from '../../src/product/image-manifest.js';
import {
  directory,
  ImageStorage,
  optionalStat,
  readBounded,
  sameSource,
} from '../../src/product/image-storage.js';
import { jsonLines } from '../product-image-variants/files.js';
import { artifactIdentity } from './artifact.js';
import {
  approvalSchema,
  entrySchema,
  equal,
  MAX_INVENTORY,
  MAX_SCOPE,
  RunnerError,
  type Entry,
} from './model.js';
import type { Options } from './options.js';

export async function trustedAncestors(path: string) {
  await directory(path);
  if (process.platform !== 'linux') return; // Windows needs operator ACL/sandbox acceptance in 5B-2.
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current, { bigint: true });
    const trustedOwner =
      info.uid === 0n || info.uid === BigInt(process.getuid!());
    const sharedStickyAncestor =
      current !== path && (info.mode & 0o1000n) !== 0n;
    if (!trustedOwner || ((info.mode & 0o022n) !== 0n && !sharedStickyAncestor))
      throw new RunnerError('UNSAFE_ANCESTOR');
    if (current === dirname(current)) break;
  }
}

export async function checkMetadata(
  path: string,
  max: number,
  writable = false,
) {
  await trustedAncestors(dirname(path));
  const info = await lstat(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    info.size > BigInt(max)
  )
    throw new RunnerError('INVALID_STATE');
  if (
    process.platform === 'linux' &&
    ((info.uid !== 0n && info.uid !== BigInt(process.getuid!())) ||
      (info.mode & (writable ? 0o077n : 0o022n)) !== 0n ||
      (writable && info.uid !== BigInt(process.getuid!())))
  )
    throw new RunnerError('INVALID_STATE');
  return info;
}

export async function readMetadata(
  path: string,
  max: number,
  writable = false,
) {
  await checkMetadata(path, max, writable);
  const file = await readBounded(dirname(path), [basename(path)], max);
  if (!file) throw new RunnerError('INVALID_STATE');
  return file;
}

export async function readInventory(path: string, batchSize: number) {
  await checkMetadata(path, MAX_INVENTORY);
  const entries: Entry[] = [];
  const seen = new Map<string, string>();
  let duplicates = 0;
  const file = await jsonLines(
    path,
    MAX_INVENTORY,
    4095,
    async (value, frame) => {
      if (frame.records > 100_000) throw new RunnerError('INVENTORY_LIMIT');
      const entry = entrySchema.parse(value);
      const version = JSON.stringify(entry.source);
      const previous = seen.get(entry.url);
      if (previous !== undefined) {
        if (previous !== version) throw new RunnerError('DUPLICATE_CONFLICT');
        duplicates++;
      } else {
        seen.set(entry.url, version);
        if (entries.length < batchSize) entries.push(entry);
      }
    },
  );
  if (entries.length !== batchSize) throw new RunnerError('INCOMPLETE_SCOPE');
  return { sha256: file.sha256, bytes: file.bytes, entries, duplicates };
}

export async function rejectLock(
  stateRoot: string,
  area: 'locks' | 'runs',
  name: string,
) {
  const parent = join(stateRoot, area);
  if (!(await optionalStat(parent))) return;
  await trustedAncestors(parent);
  const path = join(parent, name);
  if (await optionalStat(path)) throw new RunnerError('BUSY');
}

export async function prepare(options: Options) {
  const storage = await ImageStorage.open({
    sourceRoot: options.sourceRoot,
    publicRoot: options.variantsRoot,
    stateRoot: options.stateRoot,
  });
  const root = async (path: string) => {
    await trustedAncestors(path);
    const info = await directory(path);
    return { path, dev: info.dev.toString(), ino: info.ino.toString() };
  };
  const roots = {
    sourceRoot: await root(options.sourceRoot),
    variantsRoot: await root(options.variantsRoot),
    stateRoot: await root(options.stateRoot),
  };
  const inventory = await readInventory(options.inventory, options.batchSize);
  const artifact = await artifactIdentity();
  const profile = { version: 'v1' as const, ...IMAGE_VARIANT_PROFILES.v1 };
  let proposal = approvalSchema.parse({
    schemaVersion: 1,
    kind: 'product-image-backfill-approval',
    runId: randomUUID(),
    artifact,
    profile,
    roots,
    inventory: { sha256: inventory.sha256, bytes: inventory.bytes },
    batchSize: options.batchSize,
    entries: inventory.entries,
  });
  let approvalSha256: string | null = null;
  if (options.approval) {
    const file = await readMetadata(options.approval, MAX_SCOPE);
    if (file.sha256 !== options.approvalSha256)
      throw new RunnerError('APPROVAL_DIGEST');
    const approved = approvalSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.buffer)),
    );
    for (const key of [
      'artifact',
      'profile',
      'roots',
      'inventory',
      'batchSize',
      'entries',
    ] as const)
      if (!equal(approved[key], proposal[key]))
        throw new RunnerError('SCOPE_MISMATCH');
    proposal = approved;
    approvalSha256 = file.sha256;
  }
  if (options.resume && proposal.runId !== options.resume)
    throw new RunnerError('SCOPE_MISMATCH');
  return {
    storage,
    proposal,
    approvalSha256,
    duplicates: inventory.duplicates,
  };
}

// All selected sources and locks are checked before any run state is created.
export async function inspectEntries(
  storage: ImageStorage,
  options: Options,
  entries: Entry[],
) {
  const outcomes: { index: number; status: 'UNCHANGED' | 'ELIGIBLE' }[] = [];
  for (const [index, entry] of entries.entries()) {
    await rejectLock(
      options.stateRoot,
      'locks',
      productImageId(entry.url) + '.lock',
    );
    if (!sameSource(await storage.version(entry.url), entry.source))
      throw new RunnerError('SOURCE_CHANGED');
    const result = await storage.inspect(entry.url);
    if (!sameSource(result.source, entry.source))
      throw new RunnerError('SOURCE_CHANGED');
    outcomes.push({
      index,
      status: result.manifest ? 'UNCHANGED' : 'ELIGIBLE',
    });
  }
  return outcomes;
}
