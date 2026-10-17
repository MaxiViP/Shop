/**
 * One-file, real-encoder proof in a newly minted OS-temp fixture only.
 * This is NOT a production apply path, approval bypass, or systemd launcher test.
 * Run from apps/api: node --import tsx data/product-image-production/local-proof.ts
 */
import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { ImageStorage, hash } from '../../src/product/image-storage.js';
import { jsonBytes } from './model.js';
import { createFixture } from './fixture.js';
import { dryRun, runFixture } from './runner.js';
import type { Options } from './options.js';

async function fingerprint(path: string) {
  const stat = await lstat(path, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    sha256: hash(await readFile(path)),
  };
}

async function main() {
  assert.equal(process.argv.length, 2, 'No arguments or arbitrary filesystem roots accepted');
  assert.notEqual(process.env.NODE_ENV, 'production', 'Production mode refused');
  sharp.concurrency(1);
  sharp.cache({ memory: 32, files: 0, items: 50 });

  const fixture = await createFixture();
  const imageId = '550e8400-e29b-41d4-a716-446655440000';
  const url = `/uploads/products/${imageId}.webp`;
  const sourcePath = join(fixture.paths.sourceRoot, `${imageId}.webp`);
  const source = await sharp({
    create: { width: 960, height: 720, channels: 3, background: '#5a83ad' },
  }).webp().toBuffer();
  await writeFile(sourcePath, source, { flag: 'wx', mode: 0o600 });
  const before = await fingerprint(sourcePath);

  const storage = await ImageStorage.open({
    sourceRoot: fixture.paths.sourceRoot,
    publicRoot: fixture.paths.variantsRoot,
    stateRoot: fixture.paths.stateRoot,
  });
  const version = await storage.version(url);
  assert.ok(version, 'Source identity must exist');
  await writeFile(
    fixture.paths.inventory,
    JSON.stringify({ schemaVersion: 1, url, source: version }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );

  const options: Options = {
    apply: false,
    inventory: fixture.paths.inventory,
    sourceRoot: fixture.paths.sourceRoot,
    variantsRoot: fixture.paths.variantsRoot,
    stateRoot: fixture.paths.stateRoot,
    batchSize: 1,
  };
  const proposal = (await dryRun(options)).proposal;
  const approval = jsonBytes(proposal);
  assert.ok(fixture.paths.approval);
  await writeFile(fixture.paths.approval, approval, { flag: 'wx', mode: 0o600 });

  // No hooks.encode: invokes the real supervised Sharp child process.
  const result = await runFixture(fixture, {
    ...options,
    apply: true,
    approval: fixture.paths.approval,
    approvalSha256: hash(approval),
  });
  assert.equal(result.mode, 'fixture-apply');
  assert.equal(result.stopped, false);
  assert.equal(result.ready, 1);
  assert.equal(result.productionApplyBlocked, true);
  assert.deepEqual(await fingerprint(sourcePath), before, 'Original changed');

  const manifest = await storage.readReady(url);
  assert.ok(manifest, 'READY manifest missing');
  assert.deepEqual(
    manifest.candidates.flatMap((candidate) => candidate.sizes),
    [192, 384, 640],
  );
  const variants = [];
  for (const candidate of manifest.candidates) {
    const relative = candidate.url.slice('/uploads/products/'.length);
    const file = join(fixture.paths.variantsRoot, ...relative.split('/'));
    const buffer = await readFile(file);
    assert.equal(hash(buffer), candidate.sha256);
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, candidate.width);
    assert.equal(metadata.height, candidate.height);
    variants.push({ sizes: candidate.sizes, file, bytes: buffer.length });
  }
  console.log(JSON.stringify({
    localFixtureOnly: true,
    productionApplyBlocked: true,
    runId: result.runId,
    originalUntouched: true,
    fixtureRoot: fixture.root,
    variants,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'LOCAL_PROOF_FAILED');
  process.exitCode = 1;
});
