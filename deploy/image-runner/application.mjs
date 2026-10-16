// Loaded only by disposable fixtures; no application test/env bypass is added.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire('/artifact/apps/api/package.json');
const sharp = require('sharp');
const versions = () => ({ node: process.versions.node, sharp: sharp.versions.sharp,
  vips: sharp.versions.vips, platform: process.platform, arch: process.arch });
const identity = () => ({ pid: process.pid, ppid: process.ppid,
  uids: [process.getuid(), process.geteuid()], gids: [process.getgid(), process.getegid()],
  groups: process.getgroups(), status: readFileSync('/proc/self/status', 'utf8') });
const mapped = () => [...new Set(readFileSync('/proc/self/maps', 'utf8').split('\n')
  .map(line => line.match(/\s(\/\S+)$/)?.[1]).filter(Boolean))]
  .map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
function readonly(path, code = 'EROFS') {
  assert.throws(() => writeFileSync(path, 'forbidden', { flag: 'a' }), { code }, path);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'version') console.log(JSON.stringify(versions()));
  else if (process.argv[2] === 'probe') {
    assert.equal(process.getuid(), 55000);
    // Node includes the effective GID; /proc reports kernel supplementary groups.
    assert.deepEqual(process.getgroups(), [55000]);
    assert.match(readFileSync('/proc/self/status', 'utf8'), /^Groups:\s*$/m);
    readonly('/artifact/apps/api/package.json', 'EACCES');
    readonly('/storage/products/original.png');
    console.log('IMAGE_NODE_PHASE=direct-encode');
    const { generateImageVariants } = await import('/artifact/apps/api/src/product/image-variants.ts');
    const { supervisedEncode } = await import('/artifact/apps/api/data/product-image-variants/encoder.ts');
    const input = await sharp({ create: { width: 800, height: 600, channels: 3,
      background: '#2468ac' } }).png().toBuffer();
    const direct = await generateImageVariants(input);
    assert.deepEqual(direct.variants.map(item => item.width), [192, 384, 640]);
    console.log('IMAGE_NODE_PHASE=supervised-encode');
    // A small smoke input separates process/native closure from TCG throughput.
    // The larger direct encode above still exercises all three output sizes.
    const supervisedInput = await sharp({ create: { width: 96, height: 64, channels: 3,
      background: '#2468ac' } }).png().toBuffer();
    const expected = await generateImageVariants(supervisedInput);
    assert.deepEqual(expected.variants.map(item => item.sizes), [[192, 384, 640]]);
    const usage = [];
    const started = performance.now();
    let supervised;
    try {
      // Do not override the production encoder's default 30 s / 512 MiB budget.
      supervised = await supervisedEncode(supervisedInput, value => usage.push(value));
    } finally {
      console.log('IMAGE_SUPERVISED_TIMING=' + JSON.stringify({
        input: { width: 96, height: 64 }, wallMs: performance.now() - started,
        samples: usage.length, lastUsage: usage.at(-1) ?? null, timeoutMs: 30000 }));
    }
    assert.deepEqual(supervised.variants.map(item => item.sha256), expected.variants.map(item => item.sha256));
    console.log('IMAGE_NODE_PHASE=source-and-gate');
    const { artifactIdentity } = await import('/artifact/apps/api/data/product-image-production/artifact.ts');
    const sourceIdentity = await artifactIdentity();
    const cli = ['--import', 'tsx', 'data/product-image-production/run.ts',
      '--inventory', '/input/inventory.jsonl', '--source-root', '/storage/products',
      '--variants-root', '/storage/product-variants', '--state-root', '/storage/.product-image-state',
      '--apply', '--approval', '/input/approval.json', '--approval-sha256', '0'.repeat(64)];
    const gate = spawnSync('/usr/bin/node', cli, { encoding: 'utf8', timeout: 45000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TSX_DISABLE_CACHE: '1', UV_THREADPOOL_SIZE: '1' } });
    assert.equal(gate.status, 1, gate.stderr);
    assert.equal(gate.stdout, '');
    assert.deepEqual(JSON.parse(gate.stderr), { error: 'SANDBOX_UNVERIFIED' });
    console.log('IMAGE_NODE_PHASE=mapped-hashes');
    console.log('IMAGE_NODE_RESULT=' + JSON.stringify({ versions: versions(), identity: identity(),
      sourceIdentity, variants: direct.variants.map(({ sizes, width, height, bytes, sha256 }) =>
        ({ sizes, width, height, bytes, sha256 })), supervised: true,
      supervisedInput: { width: 96, height: 64 },
      productionApply: 'SANDBOX_UNVERIFIED', mapped: mapped() }));
  } else throw new Error('fixed disposable probe mode required');
} else {
  // Intercept one exact compiled module. The real DbService/PrismaPg constructor
  // is never evaluated; all other application modules and main.js are unchanged.
  registerHooks({ load(url, context, next) {
    if (url !== 'file:///artifact/apps/api/dist/db/db.service.js') return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export class DbService {
        async $transaction() { throw new Error('DB forbidden in disposable fixture'); }
        async $queryRaw() { throw new Error('DB forbidden in disposable fixture'); }
        onModuleDestroy() { console.log('API_FIXTURE_DESTROY'); }
        onApplicationShutdown(signal) { console.log('API_FIXTURE_SHUTDOWN=' + signal); }
      }
    ` };
  } });
  assert.equal(process.pid, 1);
  assert.equal(process.env.DATABASE_URL, undefined);
  readonly('/storage/product-variants/private');
  readonly('/storage/.product-image-state/private');
  console.log('API_FIXTURE_BOOT=' + JSON.stringify({ versions: versions(), identity: identity(), mapped: mapped() }));
}
