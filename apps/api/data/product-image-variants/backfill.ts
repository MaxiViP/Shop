import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  imageManifestSchema,
  productImageId,
  type ImageManifest,
} from '../../src/product/image-manifest.js';
import {
  directory,
  hash,
  ImageStorage,
  ImageStorageError,
  sameSource,
  writePrivate,
  type ImageEncoder,
} from '../../src/product/image-storage.js';
import {
  ImageJobError,
  supervisedEncode,
  type WorkerUsage,
} from './encoder.js';
import {
  journalWriter,
  jsonLines,
  readJson,
  replaceJson,
  runLock,
} from './files.js';
import {
  MAX_SCOPE,
  runIdSchema,
  validateOptions,
  type BackfillOptions,
} from './options.js';

const inventorySchema = z.strictObject({
  imageId: z.string().min(1).max(128),
  productId: z.string().min(1).max(128),
  url: z.string().min(1).max(512),
});
const versionSchema = imageManifestSchema.shape.source.pick({
  bytes: true,
  sha256: true,
  fingerprint: true,
});
const entrySchema = inventorySchema.extend({
  version: versionSchema.nullable(),
  inputError: z.enum(['INVALID_URL', 'INVALID_FILE', 'MISSING']).nullable(),
});
const identitySchema = z.strictObject({
  dev: z.string().regex(/^[0-9]+$/),
  ino: z.string().regex(/^[0-9]+$/),
});
const scopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal('v1'),
  runId: runIdSchema,
  limit: z.number().int().min(1).max(MAX_SCOPE),
  manifest: z.string(),
  inventoryHash: z.string().length(64),
  inventoryBytes: z.number().int().nonnegative(),
  roots: z.strictObject({
    sourceRoot: z.string(),
    variantsRoot: z.string(),
    stateRoot: z.string(),
  }),
  identities: z.array(identitySchema).length(3),
  entries: z.array(entrySchema).max(MAX_SCOPE),
});
type Scope = z.infer<typeof scopeSchema>;
type Entry = Scope['entries'][number];
const outcomeSchema = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_SCOPE - 1),
  status: z.enum([
    'READY',
    'UNCHANGED',
    'ELIGIBLE',
    'SKIPPED',
    'FAILED',
    'DEFERRED',
  ]),
  code: z
    .string()
    .regex(/^[A-Z_]+$/)
    .max(40)
    .nullable(),
  manifest: imageManifestSchema.nullable(),
  durationMs: z.number().nonnegative(),
});
type Outcome = z.infer<typeof outcomeSchema>;
const recordSchema = outcomeSchema.extend({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  attempt: runIdSchema,
});
const checkpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  scopeHash: z.string().length(64),
  attempt: runIdSchema,
  completed: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(MAX_SCOPE - 1),
    )
    .max(MAX_SCOPE),
  cursor: z.number().int().min(0).max(MAX_SCOPE),
  journalBytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024 * 1024),
  journalHash: z.string().length(64),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
export interface BackfillReport {
  mode: 'dry-run' | 'apply';
  runId: string | null;
  considered: number;
  processed: number;
  ready: number;
  unchanged: number;
  eligible: number;
  failed: number;
  skipped: number;
  stopped: boolean;
  errorCode: string | null;
  durationMs: number;
  originalBytes: number;
  sourceBytes: number;
  profiles: {
    size: 192 | 384 | 640;
    bytes: number;
    reductionPercent: number | null;
  }[];
  errors: { index: number; code: string }[];
  workerPeakRss: number;
  workerCpuMs: number;
}
export interface BackfillHooks {
  signal?: AbortSignal;
  onRun?: (runId: string) => void;
  // Encoder seam reuses the storage contract. Fault hook exercises the READY/journal gap.
  encode?: ImageEncoder;
  beforeJournal?: (outcome: Readonly<Outcome>) => Promise<void>;
}

function codeOf(error: unknown): string {
  if (error instanceof ImageStorageError || error instanceof ImageJobError)
    return error.code;
  return 'IO';
}
function permanent(error: unknown) {
  return ['INVALID_SOURCE', 'INVALID_FILE', 'SOURCE_CHANGED'].includes(
    codeOf(error),
  );
}
function managed(url: string) {
  try {
    productImageId(url);
    return true;
  } catch {
    return false;
  }
}
const rootsOf = (options: BackfillOptions) => ({
  sourceRoot: options.sourceRoot,
  variantsRoot: options.variantsRoot,
  stateRoot: options.stateRoot,
});
async function identities(options: BackfillOptions) {
  const result: Scope['identities'] = [];
  for (const root of Object.values(rootsOf(options))) {
    const info = await directory(root);
    result.push({ dev: info.dev.toString(), ino: info.ino.toString() });
  }
  return result;
}
async function inventory(path: string, limit: number) {
  const entries: z.infer<typeof inventorySchema>[] = [];
  const selected = new Set<string>();
  const file = await jsonLines(path, 32 * 1024 * 1024, 4096, async (value) => {
    const row = inventorySchema.parse(value);
    if (entries.length < limit && !selected.has(row.url)) {
      selected.add(row.url);
      entries.push(row);
    }
  });
  return { ...file, entries };
}
async function snapshot(
  storage: ImageStorage,
  url: string,
): Promise<Pick<Entry, 'version' | 'inputError'>> {
  if (!managed(url)) return { version: null, inputError: 'INVALID_URL' };
  try {
    const version = await storage.version(url);
    return { version, inputError: version ? null : 'MISSING' };
  } catch (error) {
    if (error instanceof ImageStorageError && error.code === 'INVALID_FILE')
      return { version: null, inputError: 'INVALID_FILE' };
    throw error;
  }
}
function cursor(completed: Set<number>) {
  let index = 0;
  while (completed.has(index)) index++;
  return index;
}
async function diskAdmission(options: BackfillOptions) {
  // Conservative bounded test-run reserve; not an operational capacity estimate.
  for (const root of [options.stateRoot, options.variantsRoot]) {
    const fs = await statfs(root, { bigint: true });
    const reserve =
      1024n * 1024n * 1024n + BigInt(options.concurrency) * 16n * 1024n * 1024n;
    if (fs.bavail * fs.bsize < reserve || (fs.files > 0n && fs.ffree < 256n))
      throw new ImageStorageError('IO');
  }
}
async function replay(path: string, scope: Scope, checkpoint: Checkpoint) {
  const completed = new Set<number>();
  let prefix =
    checkpoint.journalBytes === 0 &&
    checkpoint.journalHash === hash(Buffer.alloc(0));
  const file = await jsonLines(
    path,
    64 * 1024 * 1024,
    24 * 1024,
    async (value, frame) => {
      const record = recordSchema.parse(value);
      const entry = scope.entries[record.index];
      if (
        !entry ||
        record.runId !== scope.runId ||
        record.status === 'ELIGIBLE'
      )
        throw new ImageStorageError('INVALID_FILE');
      if (
        record.manifest &&
        (record.manifest.source.url !== entry.url ||
          !entry.version ||
          !sameSource(record.manifest.source, entry.version))
      )
        throw new ImageStorageError('INVALID_FILE');
      if (
        (record.status === 'READY' || record.status === 'UNCHANGED') !==
        (record.manifest !== null)
      )
        throw new ImageStorageError('INVALID_FILE');
      if (
        frame.bytes <= checkpoint.journalBytes &&
        record.attempt === checkpoint.attempt
      )
        completed.add(record.index);
      if (frame.bytes === checkpoint.journalBytes)
        prefix = frame.sha256 === checkpoint.journalHash;
    },
    true,
  );
  if (
    !prefix ||
    checkpoint.cursor !== cursor(completed) ||
    JSON.stringify([...completed].sort((a, b) => a - b)) !==
      JSON.stringify(checkpoint.completed)
  )
    throw new ImageStorageError('INVALID_FILE');
  return file;
}

export async function backfill(
  input: BackfillOptions,
  hooks: BackfillHooks = {},
): Promise<BackfillReport> {
  const started = performance.now();
  const options = validateOptions(input);
  const storage = await ImageStorage.open({
    sourceRoot: options.sourceRoot,
    publicRoot: options.variantsRoot,
    stateRoot: options.stateRoot,
  });
  const rootIdentities = await identities(options);
  const checkRoots = async () => {
    if (
      JSON.stringify(await identities(options)) !==
      JSON.stringify(rootIdentities)
    )
      throw new ImageStorageError('INVALID_PATH');
    // Recheck private root owner/mode as well as identity.
    await ImageStorage.open({
      sourceRoot: options.sourceRoot,
      publicRoot: options.variantsRoot,
      stateRoot: options.stateRoot,
    });
    await release?.check();
  };
  let scope: Scope;
  let runDir: string | undefined;
  let checkpoint: Checkpoint | undefined;
  let release: Awaited<ReturnType<typeof runLock>> | undefined;
  let writer: Awaited<ReturnType<typeof journalWriter>> | undefined;
  try {
    if (options.resume) {
      runDir = join(options.stateRoot, 'runs', options.resume);
      scope = scopeSchema.parse(
        await readJson(join(runDir, 'scope.json'), 256 * 1024),
      );
      if (
        scope.runId !== options.resume ||
        scope.manifest !== options.manifest ||
        JSON.stringify(scope.roots) !== JSON.stringify(rootsOf(options)) ||
        JSON.stringify(scope.identities) !== JSON.stringify(rootIdentities) ||
        (options.limit !== undefined && options.limit !== scope.limit)
      )
        throw new ImageStorageError('CONFLICT');
      const current = await inventory(options.manifest, scope.limit);
      if (
        current.sha256 !== scope.inventoryHash ||
        current.bytes !== scope.inventoryBytes ||
        JSON.stringify(current.entries) !==
          JSON.stringify(
            scope.entries.map(({ imageId, productId, url }) => ({
              imageId,
              productId,
              url,
            })),
          )
      )
        throw new ImageStorageError('CONFLICT');
      if (options.apply) {
        await checkRoots();
        release = await runLock(join(runDir, 'run.lock'));
      }
      checkpoint = checkpointSchema.parse(
        await readJson(join(runDir, 'checkpoint.json'), 16 * 1024),
      );
      if (
        checkpoint.runId !== scope.runId ||
        checkpoint.scopeHash !== hash(Buffer.from(JSON.stringify(scope) + '\n'))
      )
        throw new ImageStorageError('INVALID_FILE');
    } else {
      const limit = options.limit ?? 20;
      const current = await inventory(options.manifest, limit);
      const entries: Entry[] = [];
      for (const entry of current.entries)
        entries.push({ ...entry, ...(await snapshot(storage, entry.url)) });
      scope = scopeSchema.parse({
        schemaVersion: 1,
        profile: 'v1',
        runId: randomUUID(),
        limit,
        manifest: options.manifest,
        inventoryHash: current.sha256,
        inventoryBytes: current.bytes,
        roots: rootsOf(options),
        identities: rootIdentities,
        entries,
      });
    }
    let journal = { completeBytes: 0, completeHash: hash(Buffer.alloc(0)) };
    if (checkpoint)
      journal = await replay(join(runDir!, 'journal.jsonl'), scope, checkpoint);
    if (options.apply) {
      await checkRoots();
      await diskAdmission(options);
      if (!options.resume) {
        runDir = join(options.stateRoot, 'runs', scope.runId);
        const dir = await directory(runDir, true);
        if (dir.dev.toString() !== rootIdentities[2]!.dev)
          throw new ImageStorageError('UNSUPPORTED_FS');
        release = await runLock(join(runDir, 'run.lock'));
        await writePrivate(
          join(runDir, 'scope.json'),
          Buffer.from(JSON.stringify(scope) + '\n'),
        );
        const stored = scopeSchema.parse(
          await readJson(join(runDir, 'scope.json'), 256 * 1024),
        );
        if (JSON.stringify(stored) !== JSON.stringify(scope))
          throw new ImageStorageError('INVALID_FILE');
        await writePrivate(join(runDir, 'journal.jsonl'), Buffer.alloc(0));
      }
      writer = await journalWriter(
        join(runDir!, 'journal.jsonl'),
        journal.completeBytes,
        journal.completeHash,
      );
    }
    const attempt = randomUUID();
    const completed = new Set<number>();
    const saveCheckpoint = async (bytes: number, sha256: string) => {
      await checkRoots();
      await replaceJson(join(runDir!, 'checkpoint.json'), {
        schemaVersion: 1,
        runId: scope.runId,
        scopeHash: hash(Buffer.from(JSON.stringify(scope) + '\n')),
        attempt,
        completed: [...completed].sort((a, b) => a - b),
        cursor: cursor(completed),
        journalBytes: bytes,
        journalHash: sha256,
      } satisfies Checkpoint);
    };
    if (options.apply) {
      await saveCheckpoint(journal.completeBytes, journal.completeHash);
      hooks.onRun?.(scope.runId);
    }
    const outcomes: Outcome[] = [];
    let fatal: string | null = null;
    let workerPeakRss = 0;
    let workerCpuMs = 0;
    const encode: ImageEncoder =
      hooks.encode ??
      ((source) => {
        let lastCpu = 0;
        return supervisedEncode(source, (usage: WorkerUsage) => {
          workerPeakRss = Math.max(workerPeakRss, usage.peakRss);
          workerCpuMs += Math.max(0, usage.cpuMs - lastCpu);
          lastCpu = usage.cpuMs;
        });
      });
    let writes = Promise.resolve();
    const record = async (outcome: Outcome) => {
      if (!options.apply) return;
      const next = writes.then(async () => {
        await hooks.beforeJournal?.(outcome);
        await checkRoots();
        const position = await writer!.append({
          ...outcome,
          schemaVersion: 1,
          runId: scope.runId,
          attempt,
        });
        completed.add(outcome.index);
        await saveCheckpoint(position.bytes, position.sha256);
      });
      writes = next;
      await next;
    };
    let nextIndex = 0;
    const work = async () => {
      while (!fatal && !hooks.signal?.aborted) {
        const index = nextIndex++;
        const entry = scope.entries[index];
        if (!entry) break;
        const jobStarted = performance.now();
        let status: Outcome['status'] = 'SKIPPED';
        let code: string | null = null;
        let manifest: ImageManifest | null = null;
        try {
          await checkRoots();
          const current = await snapshot(storage, entry.url);
          if (
            !sameSource(current.version, entry.version) ||
            current.inputError !== entry.inputError
          )
            code = 'SOURCE_CHANGED';
          else if (entry.inputError) code = entry.inputError;
          else {
            if (options.apply) {
              await diskAdmission(options);
              const saved = await storage.save(
                entry.url,
                encode,
                entry.version!,
              );
              status = saved.status;
              manifest = saved.manifest;
            } else {
              const inspected = await storage.inspect(entry.url);
              if (!sameSource(inspected.source, entry.version))
                code = 'SOURCE_CHANGED';
              else {
                manifest = inspected.manifest;
                status = manifest ? 'UNCHANGED' : 'ELIGIBLE';
              }
            }
          }
        } catch (error) {
          code = codeOf(error);
          status = permanent(error) ? 'FAILED' : 'DEFERRED';
          if (!permanent(error)) fatal ??= code;
        }
        const outcome: Outcome = {
          index,
          status,
          code,
          manifest,
          durationMs: performance.now() - jobStarted,
        };
        outcomes.push(outcome);
        try {
          await record(outcome);
        } catch (error) {
          fatal ??= codeOf(error);
        }
      }
    };
    // At most two active jobs; each drops its bounded source buffers before the next.
    await Promise.all(
      Array.from({ length: options.concurrency }, () => work()),
    );
    await writes.catch((error: unknown) => {
      fatal ??= codeOf(error);
    });
    if (hooks.signal?.aborted) fatal ??= 'INTERRUPTED';
    const valid = outcomes.filter((outcome) => outcome.manifest !== null);
    const originalBytes = valid.reduce(
      (sum, outcome) => sum + outcome.manifest!.source.bytes,
      0,
    );
    return {
      mode: options.apply ? 'apply' : 'dry-run',
      runId: options.apply || options.resume ? scope.runId : null,
      considered: scope.entries.length,
      processed: outcomes.length,
      ready: outcomes.filter((outcome) => outcome.status === 'READY').length,
      unchanged: outcomes.filter((outcome) => outcome.status === 'UNCHANGED')
        .length,
      eligible: outcomes.filter((outcome) => outcome.status === 'ELIGIBLE')
        .length,
      failed: outcomes.filter((outcome) => outcome.status === 'FAILED').length,
      skipped: outcomes.filter((outcome) => outcome.status === 'SKIPPED')
        .length,
      stopped: fatal !== null,
      errorCode: fatal,
      durationMs: performance.now() - started,
      originalBytes,
      sourceBytes: scope.entries.reduce(
        (sum, entry) => sum + (entry.version?.bytes ?? 0),
        0,
      ),
      profiles: ([192, 384, 640] as const).map((size) => {
        const bytes = valid.reduce(
          (sum, outcome) =>
            sum +
            outcome.manifest!.candidates.find((candidate) =>
              candidate.sizes.includes(size),
            )!.bytes,
          0,
        );
        return {
          size,
          bytes,
          reductionPercent: originalBytes
            ? Math.round((1 - bytes / originalBytes) * 10_000) / 100
            : null,
        };
      }),
      errors: outcomes
        .filter((outcome) => outcome.code !== null)
        .map((outcome) => ({ index: outcome.index, code: outcome.code! })),
      workerPeakRss,
      workerCpuMs,
    };
  } finally {
    try {
      await writer?.close();
    } finally {
      await release?.();
    }
  }
}
