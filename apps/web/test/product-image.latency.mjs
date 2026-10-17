// Opt-in loopback HTTP measurement, no database or external traffic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { express, productImageFixture } from './fixtures/product-images.mjs';

const fixture = await productImageFixture();
const products = Array.from({ length: 24 }, (_, id) => ({
  id, images: [{ url: fixture.images[id % fixture.images.length].url, alt: null }],
}));
const app = express();
app.get('/api/products', async (req, res) => {
  const items = req.query.variants === 'true' ? await fixture.registry.enrich(products) : products;
  res.json({ items });
});
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const histogram = monitorEventLoopDelay({ resolution: 10 });
const sample = async enabled => {
  const start = performance.now();
  const response = await fetch(base + '/api/products?variants=' + enabled);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.items.length, 24);
  assert.equal(Boolean(body.items[0].images[0].variants), enabled);
  return performance.now() - start;
};
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { requests: values.length, p50Ms: sorted[Math.floor(sorted.length * .5)],
    p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1) };
};
let worker;
try {
  const coldMs = await sample(true);
  for (let i = 0; i < 10; i++) { await sample(false); await sample(true); }
  const off = [], on = [], busy = [];
  histogram.enable();
  for (let i = 0; i < 100; i++) {
    // Alternate ordering to limit warmup/time bias.
    if (i % 2) { on.push(await sample(true)); off.push(await sample(false)); }
    else { off.push(await sample(false)); on.push(await sample(true)); }
  }
  const apiDirectory = fileURLToPath(new URL('../../api/', import.meta.url));
  const workload = `import { readFile } from 'node:fs/promises';
    import { supervisedEncode } from './data/product-image-variants/encoder.ts';
    const source = await readFile(${JSON.stringify(fixture.sourceRoot + '/' + fixture.images[0].url.split('/').at(-1))});
    for (let i=0;i<8;i++) await supervisedEncode(source);`;
  worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workload], {
    cwd: apiDirectory, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP, TMP: process.env.TMP, TSX_DISABLE_CACHE: '1', UV_THREADPOOL_SIZE: '1' },
  });
  let diagnostic = '';
  worker.stderr.on('data', chunk => { diagnostic += chunk; });
  const ended = once(worker, 'exit');
  for (let i = 0; i < 100 && worker.exitCode === null; i++) busy.push(await sample(true));
  const [code] = await ended;
  assert.equal(code, 0, diagnostic);
  assert.ok(busy.length > 0);
  histogram.disable();
  const report = { scope: 'Loopback Express + real ImageRegistry; 24 positions, 3 distinct photos; no DB',
    firstLookupMs: coldMs, disabled: summary(off), enabledWarm: summary(on),
    enabledDuringSeparateEncoder: summary(busy), eventLoopP95Ms: histogram.percentile(95) / 1e6,
    encoderInHttpRequest: false, workerIsolatedProcess: true };
  const directory = fileURLToPath(new URL('../../../work/image-production/', import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(directory + 'latency.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  histogram.disable();
  if (worker?.exitCode === null) worker.kill();
  await new Promise(resolve => server.close(resolve));
  await fixture.close();
}
