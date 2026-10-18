// Verify the already typechecked API build against Linux emit and native lint.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 55000);
assert.equal(process.pid, 1);
const root = '/run/db-build';
const require = createRequire(import.meta.url);
const ts = require(root + '/compiler/lib/typescript.js');
const parsed = ts.readConfigFile(root + '/api/tsconfig.json', ts.sys.readFile);
assert.equal(parsed.error, undefined);
const options = ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions, root + '/api');
assert.deepEqual(options.errors, []);
const source = root + '/api/src/db/db.service.ts';
const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
const checks = JSON.parse(readFileSync(root + '/checks.json', 'utf8'));
assert.equal(checks.apiSourceSha256, sourceSha256);
for (const command of ['pnpm.cmd --filter api typecheck', 'pnpm.cmd --filter api lint', 'pnpm.cmd --filter api build']) {
  assert.equal(checks.apiChecksAlreadyCompleted.filter(item => item.command === command && item.exitCode === 0).length, 1);
}
const emitted = ts.transpileModule(readFileSync(source, 'utf8'), {
  fileName: source.replace(/\.ts$/, '.mts'),
  compilerOptions: { ...options.options, incremental: false, declaration: false, sourceMap: false },
  reportDiagnostics: true,
});
assert.equal(emitted.diagnostics.length, 0);
const compiled = readFileSync(root + '/api/compiled/db.service.js');
const clean = value => value.replaceAll('\r\n', '\n').replace(/^\/\/# sourceMappingURL=.*$/gm, '').trim();
assert.equal(clean(emitted.outputText), clean(compiled.toString('utf8')));
const libraries = JSON.parse(readFileSync(root + '/lint-libraries.json', 'utf8'));
assert.equal(libraries.sourceImage, 'postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af');
assert.equal(createHash('sha256').update(readFileSync('/usr/lib/x86_64-linux-gnu/libc.so.6')).digest('hex'), libraries.libcSha256);
assert.equal(createHash('sha256').update(readFileSync(root + '/lib/librt.so.1')).digest('hex'), libraries.librtSha256);
const lint = spawnSync(process.execPath, [root + '/oxlint/bin/oxlint', '--deny-warnings', source],
  { cwd: root + '/api', encoding: 'utf8', timeout: 30000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production',
      LD_LIBRARY_PATH: root + '/lib' } });
console.log(lint.stdout);
assert.equal(lint.status, 0, lint.stderr);
writeFileSync('/run/build-output/db.service.js', compiled, { mode: 0o444, flag: 'wx' });
console.log('DB_BUILD_RESULT=' + JSON.stringify({ typescript: ts.version,
  strictTypecheck: 'Windows API check receipt; Linux semantic check NOT VERIFIED',
  linuxEmitMatchesCompiled: true,
  lintLibraries: libraries,
  typecheckReceiptSha256: createHash('sha256').update(readFileSync(root + '/checks.json')).digest('hex'),
  linuxLint: 'oxlint 1.80.0', sourceSha256,
  outputSha256: createHash('sha256').update(compiled).digest('hex'),
  productionApply: 'SANDBOX_UNVERIFIED' }));
