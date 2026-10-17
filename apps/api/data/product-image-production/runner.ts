import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import {
  hash,
  ImageStorageError,
  optionalStat,
  sameSource,
  writePrivate,
  type ImageEncoder,
} from '../../src/product/image-storage.js';
import {
  ImageJobError,
  supervisedEncode,
} from '../product-image-variants/encoder.js';
import {
  journalWriter,
  replaceJson,
  runLock,
} from '../product-image-variants/files.js';
import { assertFixture, type Fixture } from './fixture.js';
import { requireProductionSandbox } from './environment.js';
import { inspectEntries, prepare, readMetadata } from './input.js';
import {
  checkpointSchema,
  equal,
  jsonBytes,
  MAX_ATTEMPTS,
  MAX_SCOPE,
  RunnerError,
  type Checkpoint,
  type Outcome,
  type Scope,
} from './model.js';
import { validateOptions, type Options } from './options.js';
import {
  diskAdmission,
  newRunDirectory,
  readState,
  runDirectory,
  scopeHash,
  unlockedRun,
} from './state.js';

export interface FixtureHooks {
  encode?: ImageEncoder;
  signal?: AbortSignal;
  beforeJournal?: () => Promise<void>;
}
function codeOf(error: unknown) {
  if (
    error instanceof RunnerError ||
    error instanceof ImageStorageError ||
    error instanceof ImageJobError
  )
    return error.code;
  return 'IO';
}

// Fixture authorization is separate from the production kernel/FD admission.
export async function runFixture(
  fixture: Fixture,
  input: Options,
  hooks: FixtureHooks = {},
) {
  const options = validateOptions(input);
  await assertFixture(fixture, options);
  return execute(options, { fixture, hooks });
}
export async function dryRun(input: Options) {
  const options = validateOptions(input);
  if (options.apply) throw new RunnerError('INVALID_OPTIONS');
  const report = await execute(options);
  if (report.mode !== 'dry-run') throw new RunnerError('INVALID_STATE');
  return report;
}

export async function runProduction(input: Options, signal?: AbortSignal) {
  const options = validateOptions(input);
  if (!options.apply) throw new RunnerError('INVALID_OPTIONS');
  requireProductionSandbox(options);
  return execute(options, undefined, signal);
}

async function execute(
  options: Options,
  test?: { fixture: Fixture; hooks: FixtureHooks },
  signal?: AbortSignal,
) {
  if (options.apply && (!options.approval || !options.approvalSha256))
    throw new RunnerError('APPROVAL_REQUIRED');
  if (options.apply && !test) requireProductionSandbox(options);
  const prepared = await prepare(options);
  const { proposal, storage } = prepared;
  const scope: Scope | null = prepared.approvalSha256
    ? { approvalSha256: prepared.approvalSha256, approval: proposal }
    : null;
  const path = scope ? runDirectory(options, scope) : null;
  if (path) await unlockedRun(path);
  const previous =
    options.resume && scope ? await readState(path!, scope) : null;
  const inspected = await inspectEntries(storage, options, proposal.entries);
  if (!options.apply)
    return {
      mode: 'dry-run' as const,
      runId: proposal.runId,
      considered: proposal.entries.length,
      eligible: inspected.filter((entry) => entry.status === 'ELIGIBLE').length,
      unchanged: inspected.filter((entry) => entry.status === 'UNCHANGED')
        .length,
      duplicates: prepared.duplicates,
      proposal,
      productionApplyBlocked: true,
    };
  if (!scope || !path) throw new RunnerError('APPROVAL_REQUIRED');
  if (!options.resume && (await optionalStat(path)))
    throw new RunnerError('RESUME_REQUIRED');
  const attempt = (previous?.checkpoint.attempt ?? 0) + 1;
  if (attempt > MAX_ATTEMPTS) throw new RunnerError('ATTEMPT_LIMIT');
  const hooks = test?.hooks ?? { signal };
  const check = async () => {
    if (test) await assertFixture(test.fixture, options);
    else requireProductionSandbox(options);
    const current = await prepare(options);
    if (
      current.approvalSha256 !== scope.approvalSha256 ||
      !equal(current.proposal, scope.approval)
    )
      throw new RunnerError('SCOPE_MISMATCH');
    await release?.check();
  };
  let release: Awaited<ReturnType<typeof runLock>> | undefined;
  let writer: Awaited<ReturnType<typeof journalWriter>> | undefined;
  const outcomes: Outcome[] = [];
  let errorCode: string | null = null;
  let retainedBytes = 0;
  let workerPeakRss = 0;
  let workerCpuMs = 0;
  try {
    await check();
    retainedBytes = (await diskAdmission(options)).retainedBytes;
    if (!options.resume) await newRunDirectory(path);
    release = await runLock(join(path, 'run.lock'));
    if (!options.resume) {
      await writePrivate(join(path, 'scope.json'), jsonBytes(scope));
      if (
        (await readMetadata(join(path, 'scope.json'), MAX_SCOPE, true))
          .sha256 !== scopeHash(scope)
      )
        throw new RunnerError('INVALID_STATE');
      await writePrivate(join(path, 'journal.jsonl'), Buffer.alloc(0));
    }
    let journal = {
      bytes: previous?.journal.completeBytes ?? 0,
      sha256: previous?.journal.completeHash ?? hash(Buffer.alloc(0)),
    };
    let cursor = 0;
    const checkpoint = async () => {
      await check();
      const value: Checkpoint = {
        schemaVersion: 1,
        runId: proposal.runId,
        scopeHash: scopeHash(scope),
        attempt,
        cursor,
        journalBytes: journal.bytes,
        journalHash: journal.sha256,
      };
      await replaceJson(
        join(path, 'checkpoint.json'),
        checkpointSchema.parse(value),
      );
    };
    writer = await journalWriter(
      join(path, 'journal.jsonl'),
      journal.bytes,
      journal.sha256,
    );
    await checkpoint();
    const encode: ImageEncoder = async (source) => {
      let lastCpu = 0;
      const result = hooks.encode
        ? await hooks.encode(source)
        : await supervisedEncode(source, (usage) => {
            workerPeakRss = Math.max(workerPeakRss, usage.peakRss);
            workerCpuMs += Math.max(0, usage.cpuMs - lastCpu);
            lastCpu = usage.cpuMs;
          });
      await check();
      await diskAdmission(options);
      return result;
    };
    for (const [index, entry] of proposal.entries.entries()) {
      if (hooks.signal?.aborted) {
        errorCode = 'INTERRUPTED';
        break;
      }
      const started = performance.now();
      let outcome: Outcome;
      try {
        await check();
        retainedBytes = (await diskAdmission(options)).retainedBytes;
        const result = await storage.save(entry.url, encode, entry.source);
        const verified = await storage.inspect(entry.url);
        if (
          !verified.manifest ||
          !sameSource(verified.source, entry.source) ||
          !equal(verified.manifest, result.manifest)
        )
          throw new RunnerError('INVALID_READY');
        outcome = {
          schemaVersion: 1,
          runId: proposal.runId,
          scopeHash: scopeHash(scope),
          attempt,
          index,
          status: result.status,
          code: null,
          manifest: result.manifest,
          durationMs: performance.now() - started,
        };
      } catch (error) {
        errorCode = codeOf(error);
        outcome = {
          schemaVersion: 1,
          runId: proposal.runId,
          scopeHash: scopeHash(scope),
          attempt,
          index,
          status: 'FAILED',
          code: errorCode,
          manifest: null,
          durationMs: performance.now() - started,
        };
      }
      outcomes.push(outcome);
      try {
        await hooks.beforeJournal?.();
        await check();
        await diskAdmission(options);
        journal = await writer.append(outcome);
        cursor = index + 1;
        await checkpoint();
      } catch (error) {
        errorCode = codeOf(error);
      }
      if (errorCode) break; // Fail closed: never refill or continue after a failed source/system operation.
    }
    if (!errorCode) {
      try {
        await check();
        await inspectEntries(storage, options, proposal.entries);
      } catch (error) {
        errorCode = codeOf(error);
      }
    }
    if (hooks.signal?.aborted) errorCode ??= 'INTERRUPTED';
    return {
      mode: test ? 'fixture-apply' as const : 'production-apply' as const,
      runId: proposal.runId,
      considered: proposal.entries.length,
      processed: outcomes.length,
      ready: outcomes.filter((entry) => entry.status === 'READY').length,
      unchanged: outcomes.filter((entry) => entry.status === 'UNCHANGED')
        .length,
      failed: outcomes.filter((entry) => entry.status === 'FAILED').length,
      stopped: errorCode !== null,
      errorCode,
      outcomes,
      retainedBytes,
      workerPeakRss,
      workerCpuMs,
      productionApplyBlocked: Boolean(test),
    };
  } finally {
    try {
      await writer?.close();
    } finally {
      await release?.();
    }
  }
}
