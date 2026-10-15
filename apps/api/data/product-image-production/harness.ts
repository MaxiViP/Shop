import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  readdir,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageStorage, hash } from '../../src/product/image-storage.js';
import { parseVariantUrl } from '../../src/product/image-manifest.js';
import { artifactIdentity } from './artifact.js';
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

async function diskState(path: string) {
  const info = await statfs(path, { bigint: true });
  return {
    path,
    native: true,
    capacityBytes: (info.blocks * info.bsize).toString(),
    availableBytes: (info.bavail * info.bsize).toString(),
    freePercent: Number((info.bavail * 10_000n) / info.blocks) / 100,
    files: info.files.toString(),
    freeInodes: info.ffree.toString(),
  };
}

async function verifyFiles(
  baselines: Map<string, Awaited<ReturnType<typeof fileState>>>,
) {
  for (const [path, baseline] of baselines)
    assert.deepEqual(await fileState(path), baseline, 'File changed: ' + path);
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
  const repositoryPhotos = new Map<
    string,
    Awaited<ReturnType<typeof fileState>>
  >();
  const artifactBefore = await artifactIdentity();
  for (let index = 0; index < batchSize; index++) {
    const id = '550e8400-e29b-41d4-a716-' + String(index + 1).padStart(12, '0');
    const path = join(options.sourceRoot, id + '.webp');
    const photo = fileURLToPath(
      new URL(
        '../product-photos/2026-10-07/' + samples[index % samples.length]!,
        import.meta.url,
      ),
    );
    repositoryPhotos.set(photo, await fileState(photo));
    await copyFile(photo, path, constants.COPYFILE_EXCL);
    await chmod(path, 0o600); // Newly copied fixture only; baseline starts after setup.
    const url = '/uploads/products/' + id + '.webp';
    entries.push({ schemaVersion: 1, url, source: await storage.version(url) });
    originals.set(path, await fileState(path));
    assert.equal(originals.get(path)!.nlink, '1');
    assert.notDeepEqual(
      [originals.get(path)!.dev, originals.get(path)!.ino],
      [repositoryPhotos.get(photo)!.dev, repositoryPhotos.get(photo)!.ino],
    );
  }
  await writeFile(
    options.inventory,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  const before = await tree(fixture.root);
  const diskBefore = await Promise.all(
    [options.stateRoot, options.variantsRoot].map(diskState),
  );
  const dry = await dryRun(options);
  assert.equal(dry.eligible, batchSize);
  assert.deepEqual(
    await tree(fixture.root),
    before,
    'Dry-run wrote fixture files',
  );
  await verifyFiles(originals);
  await verifyFiles(repositoryPhotos);
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
          repositoryPhotosVerified: repositoryPhotos.size,
          diskBefore,
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
  assert.ok(first.workerPeakRss > 0, 'Expected the real supervised encoder');
  const manifests = [];
  for (const entry of entries) {
    const manifest = await storage.readReady(entry.url);
    assert.ok(manifest, 'READY must pass source/hash/decode verification');
    assert.equal(manifest.source.sha256, entry.source!.sha256);
    assert.equal(manifest.source.bytes, entry.source!.bytes);
    assert.deepEqual(manifest.source.fingerprint, entry.source!.fingerprint);
    for (const candidate of manifest.candidates) {
      parseVariantUrl(candidate.url);
      const output = await fileState(
        join(
          options.variantsRoot,
          ...candidate.url.slice('/uploads/products/'.length).split('/'),
        ),
      );
      assert.equal(output.sha256, candidate.sha256);
      assert.equal(output.bytes, String(candidate.bytes));
      assert.equal(output.nlink, '1');
      for (const original of originals.values())
        assert.notDeepEqual(
          [output.dev, output.ino],
          [original.dev, original.ino],
        );
    }
    manifests.push(manifest);
  }
  const readyBefore = await tree(join(options.stateRoot, 'ready'));
  const variantsBefore = await tree(options.variantsRoot);
  const afterApply = await tree(fixture.root);
  await assert.rejects(runFixture(fixture, approved), {
    code: 'RESUME_REQUIRED',
  });
  assert.deepEqual(await tree(fixture.root), afterApply);

  // A fresh, separately approved run may reuse outputs; an old run requires resume.
  const repeatDry = await dryRun(options);
  assert.equal(repeatDry.unchanged, batchSize);
  assert.notEqual(repeatDry.runId, dry.runId);
  assert.deepEqual({ ...repeatDry.proposal, runId: dry.runId }, dry.proposal);
  assert.deepEqual(await tree(fixture.root), afterApply);
  const repeatApproval = jsonBytes(repeatDry.proposal);
  await writeFile(fixture.paths.approval!, repeatApproval);
  const repeatOptions = {
    ...approved,
    approvalSha256: hash(repeatApproval),
  };
  const repeated = await runFixture(fixture, repeatOptions);
  assert.equal(repeated.mode, 'fixture-apply');
  assert.equal(repeated.stopped, false);
  assert.equal(repeated.unchanged, batchSize);
  assert.equal(repeated.ready, 0);
  assert.equal(repeated.workerPeakRss, 0);
  assert.equal(repeated.workerCpuMs, 0);
  assert.deepEqual(await tree(join(options.stateRoot, 'ready')), readyBefore);
  assert.deepEqual(await tree(options.variantsRoot), variantsBefore);

  const resumed = await runFixture(fixture, {
    ...repeatOptions,
    resume: repeatDry.runId,
  });
  assert.equal(resumed.mode, 'fixture-apply');
  assert.equal(resumed.stopped, false);
  assert.equal(resumed.unchanged, batchSize);
  assert.equal(resumed.ready, 0);
  assert.equal(resumed.workerPeakRss, 0);
  assert.equal(resumed.workerCpuMs, 0);
  assert.deepEqual(await tree(join(options.stateRoot, 'ready')), readyBefore);
  assert.deepEqual(await tree(options.variantsRoot), variantsBefore);
  const beforeProduction = await tree(fixture.root);
  const production = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./run.ts', import.meta.url)),
      '--inventory',
      options.inventory,
      '--source-root',
      options.sourceRoot,
      '--variants-root',
      options.variantsRoot,
      '--state-root',
      options.stateRoot,
      '--batch-size',
      String(batchSize),
      '--approval',
      repeatOptions.approval!,
      '--approval-sha256',
      repeatOptions.approvalSha256,
      '--apply',
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        TSX_DISABLE_CACHE: '1',
        NODE_ENV: 'production',
        IMAGE_SANDBOX_VERIFIED: 'true',
      },
    },
  );
  assert.equal(production.status, 1, production.stderr);
  assert.equal(production.stdout, '');
  assert.deepEqual(JSON.parse(production.stderr), {
    error: 'SANDBOX_UNVERIFIED',
  });
  assert.deepEqual(await tree(fixture.root), beforeProduction);
  await verifyFiles(originals);
  await verifyFiles(repositoryPhotos);
  assert.deepEqual(await artifactIdentity(), artifactBefore);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        fixtureRoot: fixture.root,
        batchSize,
        dryRunWrites: 0,
        ready: first.ready,
        repeatUnchanged: repeated.unchanged,
        repeatWithoutResume: 'RESUME_REQUIRED',
        resumeUnchanged: resumed.unchanged,
        reuseEncodingCalls: 0,
        readyAndVariantsUnchanged: true,
        manifests,
        originalsVerified: originals.size,
        repositoryPhotosVerified: repositoryPhotos.size,
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
        diskBefore,
        diskAfter: await Promise.all(
          [options.stateRoot, options.variantsRoot].map(diskState),
        ),
        artifactUnchanged: true,
        productionError: 'SANDBOX_UNVERIFIED',
        productionTreeWrites: 0,
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
