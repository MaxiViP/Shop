import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageStorage, hash } from '../../src/product/image-storage.js';
import { createFixture } from './fixture.js';
import { batchSchema, jsonBytes, RunnerError } from './model.js';
import { dryRun, runFixture } from './runner.js';
import type { Options } from './options.js';

async function fileState(path: string) {
  const info = await lstat(path, { bigint: true });
  return {
    sha256: hash(await readFile(path)),
    bytes: info.size.toString(),
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mtimeNs: info.mtimeNs.toString(),
    uid: info.uid.toString(),
    gid: info.gid.toString(),
    mode: info.mode.toString(),
    nlink: info.nlink.toString(),
  };
}
async function tree(path: string): Promise<unknown[]> {
  const info = await lstat(path, { bigint: true });
  const result: unknown[] = [
    path,
    info.ino.toString(),
    info.mtimeNs.toString(),
  ];
  if (info.isFile()) result.push(await fileState(path));
  if (info.isDirectory() && !info.isSymbolicLink())
    for (const name of (await readdir(path)).sort())
      result.push(await tree(join(path, name)));
  return result;
}

async function main() {
  const inputArgs = process.argv.slice(2);
  const dryOnly = inputArgs.includes('--dry-run');
  if (inputArgs.filter((arg) => arg === '--dry-run').length > 1)
    throw new RunnerError('INVALID_OPTIONS');
  const args = inputArgs.filter((arg) => arg !== '--dry-run');
  const size =
    args.length === 0
      ? 1
      : args.length === 2 && args[0] === '--batch-size'
        ? Number(args[1])
        : 0;
  const batchSize = batchSchema.parse(size);
  const fixture = await createFixture(); // Fresh workspace only; no path/adopt/production options.
  const options: Options = {
    ...fixture.paths,
    approval: undefined,
    apply: false,
    batchSize,
  };
  const samples = [
    'vkusnaya-stall/vkusnaya-stall-stuffed-peppers-500g.webp',
    'oktyabrskoe-moloko/oktyabrskoe-moloko-milk-32-1l.webp',
    'borisovskie-syry/borisovskie-syry-brie-200-250g.webp',
  ];
  const storage = await ImageStorage.open({
    sourceRoot: options.sourceRoot,
    publicRoot: options.variantsRoot,
    stateRoot: options.stateRoot,
  });
  const entries = [];
  const originals = new Map<string, Awaited<ReturnType<typeof fileState>>>();
  for (let index = 0; index < batchSize; index++) {
    const id = '550e8400-e29b-41d4-a716-' + String(index + 1).padStart(12, '0');
    const path = join(options.sourceRoot, id + '.webp');
    await copyFile(
      new URL(
        '../product-photos/2026-10-07/' + samples[index % samples.length]!,
        import.meta.url,
      ),
      path,
      constants.COPYFILE_EXCL,
    );
    await chmod(path, 0o600); // Newly copied fixture only; baseline starts after setup.
    const url = '/uploads/products/' + id + '.webp';
    entries.push({ schemaVersion: 1, url, source: await storage.version(url) });
    originals.set(path, await fileState(path));
  }
  await writeFile(
    options.inventory,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  const before = await tree(fixture.root);
  const dry = await dryRun(options);
  assert.deepEqual(
    await tree(fixture.root),
    before,
    'Dry-run wrote fixture files',
  );
  if (dryOnly) {
    console.log(
      JSON.stringify(
        {
          status: 'passed',
          mode: 'fixture-dry-run',
          fixtureRoot: fixture.root,
          batchSize,
          eligible: dry.eligible,
          dryRunWrites: 0,
          originalsVerified: originals.size,
          productionApplyBlocked: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  const approval = jsonBytes(dry.proposal);
  await writeFile(fixture.paths.approval!, approval, {
    mode: 0o600,
    flag: 'wx',
  });
  const approved: Options = {
    ...options,
    apply: true,
    approval: fixture.paths.approval,
    approvalSha256: hash(approval),
  };
  const first = await runFixture(fixture, approved);
  assert.equal(first.mode, 'fixture-apply');
  assert.equal(first.stopped, false);
  assert.equal(first.ready, batchSize);
  const readyBefore = await tree(join(options.stateRoot, 'ready'));
  const variantsBefore = await tree(options.variantsRoot);
  const resumed = await runFixture(fixture, { ...approved, resume: dry.runId });
  assert.equal(resumed.mode, 'fixture-apply');
  assert.equal(resumed.stopped, false);
  assert.equal(resumed.unchanged, batchSize);
  assert.deepEqual(await tree(join(options.stateRoot, 'ready')), readyBefore);
  assert.deepEqual(await tree(options.variantsRoot), variantsBefore);
  for (const [path, baseline] of originals)
    assert.deepEqual(await fileState(path), baseline);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        fixtureRoot: fixture.root,
        batchSize,
        dryRunWrites: 0,
        ready: first.ready,
        resumeUnchanged: resumed.unchanged,
        originalsVerified: originals.size,
        integrity: [
          'sha256',
          'bytes',
          'dev',
          'ino',
          'mtimeNs',
          'uid',
          'gid',
          'mode',
          'nlink',
        ],
        workerPeakRss: first.workerPeakRss,
        workerCpuMs: first.workerCpuMs,
        productionApplyBlocked: true,
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: 'refused',
        error: error instanceof RunnerError ? error.code : 'FIXTURE_FAILED',
        productionApplyBlocked: true,
      }),
    );
    process.exitCode = 1;
  });
}
