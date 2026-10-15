import { mkdir, opendir, lstat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  directory,
  hash,
  optionalStat,
  sameSource,
  syncDirectory,
} from '../../src/product/image-storage.js';
import { jsonLines } from '../product-image-variants/files.js';
import { checkMetadata, readMetadata, trustedAncestors } from './input.js';
import {
  checkpointSchema,
  equal,
  jsonBytes,
  MAX_ATTEMPTS,
  MAX_JOURNAL,
  MAX_SCOPE,
  recordSchema,
  RunnerError,
  scopeSchema,
  type Scope,
} from './model.js';
import type { Options } from './options.js';

export const scopeHash = (scope: Scope) => hash(jsonBytes(scope));
export const runDirectory = (options: Options, scope: Scope) =>
  join(options.stateRoot, 'production-runs', scope.approval.runId);

export async function unlockedRun(path: string) {
  const entry = await optionalStat(path);
  if (!entry) return;
  await trustedAncestors(path);
  if (await optionalStat(join(path, 'run.lock'))) throw new RunnerError('BUSY');
}

export async function newRunDirectory(path: string) {
  await directory(join(path, '..'), true);
  await mkdir(path, { mode: 0o700 }); // Exclusive; never implicitly resume an existing run.
  await syncDirectory(join(path, '..'));
}

export async function readState(path: string, scope: Scope) {
  await unlockedRun(path);
  const stored = scopeSchema.parse(
    JSON.parse(
      (
        await readMetadata(join(path, 'scope.json'), MAX_SCOPE, true)
      ).buffer.toString('utf8'),
    ),
  );
  if (!equal(stored, scope)) throw new RunnerError('SCOPE_MISMATCH');
  const checkpoint = checkpointSchema.parse(
    JSON.parse(
      (
        await readMetadata(join(path, 'checkpoint.json'), 16 * 1024, true)
      ).buffer.toString('utf8'),
    ),
  );
  if (
    checkpoint.runId !== scope.approval.runId ||
    checkpoint.scopeHash !== scopeHash(scope)
  )
    throw new RunnerError('INVALID_STATE');
  await checkMetadata(join(path, 'journal.jsonl'), MAX_JOURNAL, true);
  let prefix =
    checkpoint.journalBytes === 0 &&
    checkpoint.journalHash === hash(Buffer.alloc(0));
  let prefixCursor = 0;
  let previousAttempt = 0;
  let previousIndex = -1;
  const journal = await jsonLines(
    join(path, 'journal.jsonl'),
    MAX_JOURNAL,
    24 * 1024 - 1,
    async (value, frame) => {
      if (frame.records > 50 * MAX_ATTEMPTS)
        throw new RunnerError('INVALID_STATE');
      const record = recordSchema.parse(value);
      const entry = scope.approval.entries[record.index];
      if (record.attempt !== previousAttempt) previousIndex = -1;
      if (
        !entry ||
        record.runId !== scope.approval.runId ||
        record.scopeHash !== scopeHash(scope) ||
        record.attempt < previousAttempt ||
        record.attempt > checkpoint.attempt ||
        record.index !== previousIndex + 1 ||
        (record.status === 'FAILED'
          ? record.manifest !== null || record.code === null
          : record.manifest === null || record.code !== null) ||
        (record.manifest &&
          (record.manifest.source.url !== entry.url ||
            !sameSource(record.manifest.source, entry.source)))
      )
        throw new RunnerError('INVALID_STATE');
      previousAttempt = record.attempt;
      previousIndex = record.index;
      if (
        frame.bytes <= checkpoint.journalBytes &&
        record.attempt === checkpoint.attempt
      )
        prefixCursor++;
      if (frame.bytes === checkpoint.journalBytes)
        prefix = frame.sha256 === checkpoint.journalHash;
    },
    true,
  );
  if (!prefix || prefixCursor !== checkpoint.cursor)
    throw new RunnerError('INVALID_STATE');
  return { checkpoint, journal };
}

// Bounded accounting, not a quota/reservation. No symlink traversal or automatic GC.
export async function diskAdmission(options: Options) {
  let retained = 0n;
  let entries = 0;
  const maxRetained = 512n * 1024n * 1024n;
  const visit = async (path: string): Promise<void> => {
    if (++entries > 20_000) throw new RunnerError('RETAINED_LIMIT');
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) throw new RunnerError('INVALID_STATE');
    if (info.isFile()) retained += info.size;
    else if (info.isDirectory()) {
      const dir = await opendir(path);
      for await (const entry of dir) await visit(join(path, entry.name));
    } else throw new RunnerError('INVALID_STATE');
    if (retained > maxRetained) throw new RunnerError('RETAINED_LIMIT');
  };
  for (const root of [options.stateRoot, options.variantsRoot]) {
    await trustedAncestors(root);
    const fs = await statfs(root, { bigint: true });
    const reserve =
      (fs.blocks * fs.bsize) / 10n > 1024n ** 3n
        ? (fs.blocks * fs.bsize) / 10n
        : 1024n ** 3n;
    const growth =
      BigInt(options.batchSize + 1) * 6n * 1024n * 1024n +
      BigInt(MAX_JOURNAL + MAX_SCOPE);
    if (
      fs.bavail * fs.bsize < reserve + growth ||
      (fs.files > 0n && fs.ffree < 1024n + BigInt(options.batchSize * 16))
    )
      throw new RunnerError('DISK_LIMIT');
    await visit(root);
  }
  const growth =
    BigInt(options.batchSize + 1) * 6n * 1024n * 1024n +
    BigInt(MAX_JOURNAL + MAX_SCOPE);
  if (
    retained + growth > maxRetained ||
    entries + options.batchSize * 16 + 3 > 20_000
  )
    throw new RunnerError('RETAINED_LIMIT');
  return { retainedBytes: Number(retained), entries };
}
