import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ImageStorage, hash } from '../../src/product/image-storage.js';
import {
  generateImageVariants,
  type ImageVariants,
} from '../../src/product/image-variants.js';
import {
  parseOptions as parseTestOptions,
  validateOptions as validateTestOptions,
} from '../product-image-variants/options.js';
import { createFixture, type Fixture } from './fixture.js';
import { requireProductionSandbox } from './environment.js';
import { jsonBytes, type Approval, type Entry } from './model.js';
import { parseOptions, type Options } from './options.js';
import { dryRun, runFixture } from './runner.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: vi.fn(native.open),
    rename: vi.fn(native.rename),
    statfs: vi.fn(native.statfs),
  };
});
const native =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
// Unit capacity model only. Real available bytes/inodes and all successful file writes stay native.
// The standalone harness uses unmocked statfs and must refuse a real reserve breach.
const unitStatfs = async (path: Parameters<typeof native.statfs>[0]) => {
  const value = await native.statfs(path, { bigint: true });
  return { ...value, blocks: value.bavail * 2n };
};
let fixture: Fixture;
let options: Options;
let source: Buffer;
let generated: ImageVariants;
let rows: Entry[];
let originals: Map<string, Awaited<ReturnType<typeof fileState>>>;
const id = (index: number) =>
  '550e8400-e29b-41d4-a716-' + String(index).padStart(12, '0');
const url = (index: number) => '/uploads/products/' + id(index) + '.webp';
const inputPath = (index: number) =>
  join(options.sourceRoot, id(index) + '.webp');
const store = () =>
  ImageStorage.open({
    sourceRoot: options.sourceRoot,
    publicRoot: options.variantsRoot,
    stateRoot: options.stateRoot,
  });
const outputPath = (url: string) =>
  join(
    options.variantsRoot,
    ...url.slice('/uploads/products/'.length).split('/'),
  );
const runPath = (runId: string, name: string) =>
  join(options.stateRoot, 'production-runs', runId, name);
const encode = () => Promise.resolve(generated);
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
const inventory = (values: unknown[] = rows) =>
  writeFile(
    options.inventory,
    values.map((value) => JSON.stringify(value)).join('\n') + '\n',
    { mode: 0o600 },
  );
async function approve(change?: (value: Approval) => unknown) {
  const proposed = (
    await dryRun({
      ...options,
      apply: false,
      approval: undefined,
      approvalSha256: undefined,
      resume: undefined,
    })
  ).proposal;
  const data = jsonBytes(change ? change(proposed) : proposed);
  await writeFile(fixture.paths.approval!, data, { mode: 0o600 });
  options = {
    ...options,
    apply: true,
    approval: fixture.paths.approval,
    approvalSha256: hash(data),
  };
  return proposed;
}
const apply = () => runFixture(fixture, options, { encode });
const args = () => [
  '--inventory',
  options.inventory,
  '--source-root',
  options.sourceRoot,
  '--variants-root',
  options.variantsRoot,
  '--state-root',
  options.stateRoot,
];
async function emptyOutputs() {
  expect(await readdir(options.stateRoot)).toEqual([]);
  expect(await readdir(options.variantsRoot)).toEqual([]);
}
beforeAll(async () => {
  source = await sharp({
    create: { width: 960, height: 720, channels: 3, background: '#5a83ad' },
  })
    .webp()
    .toBuffer();
  generated = await generateImageVariants(source);
});
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(native.open);
  vi.mocked(rename).mockReset().mockImplementation(native.rename);
  vi.mocked(statfs).mockReset().mockImplementation(unitStatfs);
  fixture = await createFixture();
  options = {
    ...fixture.paths,
    approval: undefined,
    apply: false,
    batchSize: 1,
  };
  rows = [];
  originals = new Map();
  const storage = await store();
  for (let index = 1; index <= 6; index++) {
    await writeFile(inputPath(index), source, { mode: 0o600, flag: 'wx' });
    rows.push({
      schemaVersion: 1,
      url: url(index),
      source: (await storage.version(url(index)))!,
    });
    originals.set(inputPath(index), await fileState(inputPath(index)));
  }
  await inventory();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(open).mockImplementation(native.open);
  vi.mocked(rename).mockImplementation(native.rename);
  vi.mocked(statfs).mockImplementation(native.statfs);
  try {
    for (const [path, baseline] of originals)
      expect(await fileState(path)).toEqual(baseline);
  } finally {
    const target = resolve(fixture.root);
    // Verify the absolute generated target before recursive Windows cleanup; never follow a replaced root.
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(
      target.startsWith(
        resolve(tmpdir()) + sep + 'korzina-image-production-fixture-',
      ),
    ).toBe(true);
    expect(resolve(await realpath(target))).toBe(target);
    await rm(target, { recursive: true, force: true });
  }
});

describe('production image runner preparation', () => {
  it('defaults to bounded read-only dry-run with zero tree changes and no approval', async () => {
    const before = await tree(fixture.root);
    const report = await dryRun(parseOptions(args()));
    expect(report).toMatchObject({
      mode: 'dry-run',
      considered: 1,
      eligible: 1,
      productionApplyBlocked: true,
    });
    expect(report.proposal.entries).toEqual([rows[0]]);
    expect(await tree(fixture.root)).toEqual(before);
  });
  it('refuses apply without approval before any state writes', async () => {
    await expect(
      runFixture(fixture, { ...options, apply: true }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await emptyOutputs();
  });
  it('refuses a wrong approval digest without writes', async () => {
    await approve();
    options.approvalSha256 = '0'.repeat(64);
    await expect(apply()).rejects.toMatchObject({ code: 'APPROVAL_DIGEST' });
    await emptyOutputs();
  });
  it.each([
    'artifact',
    'profile',
    'root',
    'inventory',
    'source hash',
    'scope order',
    'scope URL',
    'schema',
  ] as const)('rejects incorrect approved %s', async (field) => {
    options.batchSize = 5;
    await approve((approval) => {
      if (field === 'artifact') approval.artifact.sha256 = '0'.repeat(64);
      if (field === 'root') approval.roots.stateRoot.ino = '9999999';
      if (field === 'inventory') approval.inventory.sha256 = '0'.repeat(64);
      if (field === 'source hash')
        approval.entries[0]!.source.sha256 = '0'.repeat(64);
      if (field === 'scope order') approval.entries.reverse();
      if (field === 'scope URL') approval.entries[0]!.url = url(6);
      if (field === 'profile')
        return { ...approval, profile: { ...approval.profile, version: 'v2' } };
      if (field === 'schema') return { ...approval, schemaVersion: 2 };
      return approval;
    });
    await expect(apply()).rejects.toBeDefined();
    await emptyOutputs();
  });
  it('checks the full inventory digest including duplicates beyond the batch', async () => {
    await approve();
    await appendFile(options.inventory, JSON.stringify(rows[5]) + '\n');
    await expect(apply()).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
    await emptyOutputs();
  });
  it.each(['changed', 'missing'] as const)(
    'refuses a %s original before writing any other approved source',
    async (kind) => {
      options.batchSize = 5;
      await approve();
      if (kind === 'changed') {
        await appendFile(inputPath(5), Buffer.from([0]));
        originals.set(inputPath(5), await fileState(inputPath(5)));
      } else {
        await unlink(inputPath(5));
        originals.delete(inputPath(5));
      }
      await expect(apply()).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
      await emptyOutputs();
    },
  );
  it('deduplicates exact URLs without refilling or publishing outside the approved scope', async () => {
    options.batchSize = 5;
    await inventory([rows[0], rows[0], ...rows.slice(1)]);
    const approved = await approve();
    expect(approved.entries).toEqual(rows.slice(0, 5));
    const result = await apply();
    expect(result).toMatchObject({ ready: 5, processed: 5, stopped: false });
    expect(await (await store()).readReady(url(6))).toBeNull();
  }, 15_000);
  it('rejects conflicting duplicate versions even beyond the batch', async () => {
    await inventory([
      ...rows,
      { ...rows[0], source: { ...rows[0]!.source, sha256: '0'.repeat(64) } },
    ]);
    await expect(dryRun(options)).rejects.toMatchObject({
      code: 'DUPLICATE_CONFLICT',
    });
    await emptyOutputs();
  });
  it.each([
    '../../outside.webp',
    '/uploads/products/../outside.webp',
    '/uploads/products/%2e%2e/outside.webp',
    'https://example.com/a.webp',
    url(1) + '?x=1',
    url(1).toUpperCase(),
  ])('rejects non-managed or traversal URL %s', async (badUrl) => {
    await inventory([{ ...rows[0], url: badUrl }]);
    await expect(dryRun(options)).rejects.toBeDefined();
    await emptyOutputs();
  });
  it('accepts managed UUID v8 while retaining the same scope rules', async () => {
    const value = id(1).replace('-41d4-', '-81d4-');
    const path = join(options.sourceRoot, value + '.webp');
    await writeFile(path, source, { mode: 0o600, flag: 'wx' });
    originals.set(path, await fileState(path));
    const managed = '/uploads/products/' + value + '.webp';
    await inventory([
      {
        schemaVersion: 1,
        url: managed,
        source: await (await store()).version(managed),
      },
    ]);
    await approve();
    expect(await apply()).toMatchObject({ ready: 1, stopped: false });
  });
  it.each([
    'unknown field',
    'unversioned',
    'missing newline',
    'invalid UTF-8',
    'overlong line',
    'oversized shard',
  ] as const)('rejects strict JSONL violation: %s', async (kind) => {
    if (kind === 'unknown field')
      await inventory([{ ...rows[0], path: inputPath(1) }]);
    if (kind === 'unversioned')
      await inventory([{ url: url(1), source: rows[0]!.source }]);
    if (kind === 'missing newline')
      await writeFile(options.inventory, JSON.stringify(rows[0]));
    if (kind === 'invalid UTF-8')
      await writeFile(options.inventory, Buffer.from([0xff, 10]));
    if (kind === 'overlong line')
      await writeFile(
        options.inventory,
        ' '.repeat(4096) + JSON.stringify(rows[0]) + '\n',
      );
    if (kind === 'oversized shard') {
      const file = await native.open(options.inventory, 'r+');
      await file.truncate(32 * 1024 * 1024 + 1);
      await file.close();
    }
    await expect(dryRun(options)).rejects.toBeDefined();
    await emptyOutputs();
  });
  it.each([0, 2, 3, 51, 1000, Infinity])(
    'rejects an unapproved/unbounded batch %s',
    async (batchSize) => {
      await expect(
        dryRun({ ...options, batchSize } as Options),
      ).rejects.toBeDefined();
      expect(() =>
        parseOptions([...args(), '--batch-size', String(batchSize)]),
      ).toThrow();
      await emptyOutputs();
    },
  );
  it.each([1, 5, 20, 50])(
    'parses only the explicitly supported batch %s',
    (batchSize) => {
      expect(
        parseOptions([...args(), '--batch-size', String(batchSize)]).batchSize,
      ).toBe(batchSize);
    },
  );
  it.each(
    [
      ['--concurrency', '2'],
      ['--force'],
      ['--unsafe'],
      ['--test-override'],
      ['--watch'],
      ['--batch-size', '5', '--batch-size', '5'],
      ['--apply', '--dry-run'],
    ].map((extra) => ({ extra })),
  )('has no override/watch/parallel option: $extra', ({ extra }) =>
    expect(() => parseOptions([...args(), ...extra])).toThrow(),
  );
  it('does not accept a forged fixture token or roots from another workspace', async () => {
    await approve();
    await expect(runFixture({ ...fixture }, options)).rejects.toMatchObject({
      code: 'FIXTURE_ONLY',
    });
    await expect(
      runFixture(fixture, {
        ...options,
        stateRoot: join(fixture.root, 'other'),
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_ONLY' });
    await emptyOutputs();
  });
  it('refuses a redirected temp base before creating any fixture files', async () => {
    const target = join(fixture.root, 'temp-target');
    const alias = join(fixture.root, 'temp-alias');
    await mkdir(target, { mode: 0o700 });
    await symlink(
      target,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    vi.stubEnv('TEMP', alias);
    vi.stubEnv('TMP', alias);
    vi.stubEnv('TMPDIR', alias);
    await expect(createFixture()).rejects.toBeDefined();
    expect(await readdir(target)).toEqual([]);
  });
  it('rejects a replaced root even if a new approval is supplied', async () => {
    const old = options.stateRoot + '-old';
    await native.rename(options.stateRoot, old);
    await mkdir(options.stateRoot, { mode: 0o700 });
    await approve();
    await expect(apply()).rejects.toMatchObject({ code: 'FIXTURE_ONLY' });
    await emptyOutputs();
  });
  it('rejects a symlink/junction ancestor without following it', async () => {
    const saved = join(fixture.root, 'saved-sources');
    await native.rename(options.sourceRoot, saved);
    const savedOriginals = new Map(originals);
    originals.clear();
    for (const [path, baseline] of savedOriginals) {
      originals.set(
        join(saved, path.slice(options.sourceRoot.length + 1)),
        baseline,
      );
    }
    await symlink(
      saved,
      options.sourceRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const before = await tree(fixture.root);
    await expect(dryRun(options)).rejects.toBeDefined();
    expect(await tree(fixture.root)).toEqual(before);
  });
  it.skipIf(process.platform !== 'linux')(
    'Linux: refuses writable unsafe ancestors with real permissions',
    async () => {
      await approve();
      await chmod(fixture.root, 0o777);
      try {
        await expect(apply()).rejects.toMatchObject({
          code: 'UNSAFE_ANCESTOR',
        });
      } finally {
        await chmod(fixture.root, 0o700);
      }
      await emptyOutputs();
    },
  );
  it('uses the real supervised encoder with the new coordinator on a fixture copy', async () => {
    await approve();
    const result = await runFixture(fixture, options);
    expect(result).toMatchObject({
      mode: 'fixture-apply',
      ready: 1,
      stopped: false,
      productionApplyBlocked: true,
    });
    if (result.mode !== 'fixture-apply')
      throw new Error('Expected fixture apply');
    expect(result.workerPeakRss).toBeGreaterThan(0);
    expect(result.workerCpuMs).toBeGreaterThan(0);
    expect(await (await store()).readReady(url(1))).not.toBeNull();
  }, 15_000);
  it('revalidates repeated runs and preserves correct output/READY inodes and mtimes', async () => {
    await approve();
    const first = await apply();
    expect(first).toMatchObject({ ready: 1, stopped: false });
    const variants = await tree(options.variantsRoot);
    const ready = await tree(join(options.stateRoot, 'ready'));
    await approve(); // A separately approved new run; never implicitly resumes the previous one.
    expect(await apply()).toMatchObject({
      unchanged: 1,
      ready: 0,
      stopped: false,
    });
    expect(await tree(options.variantsRoot)).toEqual(variants);
    expect(await tree(join(options.stateRoot, 'ready'))).toEqual(ready);
  });
  it('requires explicit resume and revalidates completed scopes without encoding', async () => {
    const approved = await approve();
    expect(await apply()).toMatchObject({ stopped: false });
    await expect(apply()).rejects.toMatchObject({ code: 'RESUME_REQUIRED' });
    const before = await tree(fixture.root);
    const readOnly = await dryRun({
      ...options,
      apply: false,
      resume: approved.runId,
    });
    expect(readOnly).toMatchObject({ unchanged: 1 });
    expect(await tree(fixture.root)).toEqual(before);
    const decoder = vi.fn(encode);
    const result = await runFixture(
      fixture,
      { ...options, resume: approved.runId },
      { encode: decoder },
    );
    expect(result).toMatchObject({ unchanged: 1, stopped: false });
    expect(decoder).not.toHaveBeenCalled();
  });
  it('recovers a missing physical variant and reuses all correct files', async () => {
    const approved = await approve();
    await apply();
    const manifest = (await (await store()).readReady(url(1)))!;
    await unlink(outputPath(manifest.candidates[2]!.url));
    const survivors = await Promise.all(
      manifest.candidates.slice(0, 2).map(async (candidate) => ({
        path: outputPath(candidate.url),
        state: await fileState(outputPath(candidate.url)),
      })),
    );
    const result = await runFixture(
      fixture,
      { ...options, resume: approved.runId },
      { encode },
    );
    expect(result).toMatchObject({ ready: 1, stopped: false });
    for (const item of survivors)
      expect(await fileState(item.path)).toEqual(item.state);
    expect(await (await store()).readReady(url(1))).not.toBeNull();
  });
  it('rebuilds partial READY only through the existing storage publisher', async () => {
    const approved = await approve();
    await apply();
    await writeFile(
      join(options.stateRoot, 'ready', id(1) + '.json'),
      '{"schemaVersion":1}\n',
    );
    const variants = await tree(options.variantsRoot);
    expect(
      await runFixture(
        fixture,
        { ...options, resume: approved.runId },
        { encode },
      ),
    ).toMatchObject({ ready: 1, stopped: false });
    expect(await tree(options.variantsRoot)).toEqual(variants);
  });
  it('preserves conflicting canonical bytes and publishes a checksum repair URL', async () => {
    const approved = await approve();
    await apply();
    const manifest = (await (await store()).readReady(url(1)))!;
    const path = outputPath(manifest.candidates[0]!.url);
    await writeFile(path, 'existing-corruption');
    const preserved = await fileState(path);
    expect(
      await runFixture(
        fixture,
        { ...options, resume: approved.runId },
        { encode },
      ),
    ).toMatchObject({ ready: 1, stopped: false });
    expect(await fileState(path)).toEqual(preserved);
    const repaired = (await (await store()).readReady(url(1)))!;
    expect(repaired.candidates[0]!.url).toContain(
      '-' + repaired.candidates[0]!.sha256 + '.webp',
    );
  });
  it('handles READY before journal append and ignores success as integrity evidence', async () => {
    const approved = await approve();
    const interrupted = await runFixture(fixture, options, {
      encode,
      beforeJournal: async () => {
        throw new Error('Simulated gap, not power loss');
      },
    });
    expect(interrupted).toMatchObject({ stopped: true, ready: 1 });
    expect(
      (await readFile(runPath(approved.runId, 'journal.jsonl'))).length,
    ).toBe(0);
    const before = await tree(options.variantsRoot);
    const decoder = vi.fn(encode);
    expect(
      await runFixture(
        fixture,
        { ...options, resume: approved.runId },
        { encode: decoder },
      ),
    ).toMatchObject({ unchanged: 1, stopped: false });
    expect(decoder).not.toHaveBeenCalled();
    expect(await tree(options.variantsRoot)).toEqual(before);
  });
  it('recovers complete journal records after an older checkpoint', async () => {
    const approved = await approve();
    let replaces = 0;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (
        String(to) === runPath(approved.runId, 'checkpoint.json') &&
        ++replaces === 2
      )
        throw Object.assign(new Error('Injected'), { code: 'EIO' });
      return native.rename(from, to);
    });
    expect(await apply()).toMatchObject({ stopped: true });
    vi.mocked(rename).mockImplementation(native.rename);
    expect(
      await runFixture(
        fixture,
        { ...options, resume: approved.runId },
        { encode },
      ),
    ).toMatchObject({ unchanged: 1, stopped: false });
  });
  it('leaves a torn journal tail unchanged in dry-run and repairs only that tail under owned lock', async () => {
    const approved = await approve();
    await apply();
    await appendFile(
      runPath(approved.runId, 'journal.jsonl'),
      '{"unfinished":',
    );
    const before = await tree(fixture.root);
    await dryRun({ ...options, apply: false, resume: approved.runId });
    expect(await tree(fixture.root)).toEqual(before);
    expect(
      await runFixture(
        fixture,
        { ...options, resume: approved.runId },
        { encode },
      ),
    ).toMatchObject({ unchanged: 1, stopped: false });
    expect(
      (await readFile(runPath(approved.runId, 'journal.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean),
    ).toHaveLength(2);
  });
  it.each(['journal', 'checkpoint', 'scope'] as const)(
    'refuses corrupt %s without truncation or any other writes',
    async (part) => {
      const approved = await approve();
      await apply();
      const name = part === 'journal' ? 'journal.jsonl' : part + '.json';
      await writeFile(runPath(approved.runId, name), '{"invalid":true}\n');
      const before = await tree(fixture.root);
      await expect(
        runFixture(fixture, { ...options, resume: approved.runId }, { encode }),
      ).rejects.toBeDefined();
      expect(await tree(fixture.root)).toEqual(before);
    },
  );
  it('refuses a hard-linked journal alias before truncating it', async () => {
    const approved = await approve();
    await apply();
    await link(
      runPath(approved.runId, 'journal.jsonl'),
      join(fixture.root, 'journal-alias'),
    );
    const before = await tree(fixture.root);
    await expect(
      runFixture(fixture, { ...options, resume: approved.runId }, { encode }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await tree(fixture.root)).toEqual(before);
  });
  it.each(['source', 'run'] as const)(
    'keeps unknown %s locks BUSY regardless of PID or age',
    async (kind) => {
      const approved = await approve();
      await apply();
      const path =
        kind === 'run'
          ? runPath(approved.runId, 'run.lock')
          : join(options.stateRoot, 'locks', id(1) + '.lock');
      await writeFile(
        path,
        '{"pid":99999999,"owner":"unknown","created":"1970-01-01"}',
        { flag: 'wx', mode: 0o600 },
      );
      const before = await tree(fixture.root);
      await expect(
        runFixture(fixture, { ...options, resume: approved.runId }, { encode }),
      ).rejects.toMatchObject({ code: 'BUSY' });
      expect(await tree(fixture.root)).toEqual(before);
    },
  );
  it('cannot resume a different approval/run even for the same originals', async () => {
    const first = await approve();
    await apply();
    await approve();
    await expect(
      runFixture(fixture, { ...options, resume: first.runId }, { encode }),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
  });
  it('bounds attempt count without automatic retries', async () => {
    const approved = await approve();
    await apply();
    const checkpoint: unknown = JSON.parse(
      await readFile(runPath(approved.runId, 'checkpoint.json'), 'utf8'),
    );
    await writeFile(
      runPath(approved.runId, 'checkpoint.json'),
      jsonBytes({
        ...(checkpoint as Record<string, unknown>),
        attempt: 10,
        cursor: 0,
      }),
    );
    const before = await tree(fixture.root);
    await expect(
      runFixture(fixture, { ...options, resume: approved.runId }, { encode }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_LIMIT' });
    expect(await tree(fixture.root)).toEqual(before);
  });
  it.each(['ENOSPC', 'EIO', 'file fsync'] as const)(
    'stops publication after injected %s without processing another source',
    async (failure) => {
      options.batchSize = 5;
      await approve();
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        const stage =
          String(path).startsWith(join(options.stateRoot, 'work') + sep) &&
          typeof flags === 'number' &&
          (flags & constants.O_CREAT) !== 0;
        if (stage && failure !== 'file fsync')
          throw Object.assign(new Error('Injected stage error'), {
            code: failure,
          });
        const handle = await native.open(path, flags, mode);
        if (stage)
          handle.sync = async () => {
            throw Object.assign(new Error('Injected sync error'), {
              code: 'EIO',
            });
          };
        return handle;
      });
      const decoder = vi.fn(encode);
      const result = await runFixture(fixture, options, { encode: decoder });
      expect(decoder).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        stopped: true,
        errorCode: 'IO',
        processed: 1,
        failed: 1,
      });
      expect(
        await readdir(options.variantsRoot, { recursive: true }),
      ).not.toContainEqual(expect.stringMatching(/\.webp$/));
      expect(await (await store()).readReady(url(1))).toBeNull();
      expect(await (await store()).readReady(url(2))).toBeNull();
    },
  );
  it('rejects low disk admission before state creation', async () => {
    await approve();
    vi.mocked(statfs).mockImplementation(async (path) => ({
      ...(await native.statfs(path, { bigint: true })),
      bavail: 0n,
    }));
    await expect(apply()).rejects.toMatchObject({ code: 'DISK_LIMIT' });
    await emptyOutputs();
  });
  it
    .skipIf(process.platform !== 'linux')
    .each(['source', 'inventory', 'approval'] as const)(
    'Linux: rejects a native file symlink at %s before writes',
    async (part) => {
      await approve();
      const target =
        part === 'source'
          ? inputPath(1)
          : part === 'inventory'
            ? options.inventory
            : options.approval!;
      const saved = join(fixture.root, 'saved-file');
      await native.rename(target, saved);
      if (part === 'source') {
        originals.delete(target);
        originals.set(saved, await fileState(saved));
      }
      await symlink(saved, target, 'file');
      const before = await tree(fixture.root);
      await expect(apply()).rejects.toBeDefined();
      expect(await tree(fixture.root)).toEqual(before);
    },
  );
  it.skipIf(process.platform !== 'linux')(
    'Linux: propagates native directory fsync failure after a successful hard link',
    async () => {
      const approved = await approve();
      const publishedDirectory = join(
        options.variantsRoot,
        'variants',
        'v1',
        id(1),
        rows[0]!.source.sha256,
      );
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        const handle = await native.open(path, flags, mode);
        if (
          String(path) === publishedDirectory &&
          typeof flags === 'number' &&
          (flags & constants.O_DIRECTORY) !== 0
        )
          handle.sync = async () => {
            throw Object.assign(new Error('Injected directory sync error'), {
              code: 'EIO',
            });
          };
        return handle;
      });
      expect(await apply()).toMatchObject({ stopped: true, errorCode: 'IO' });
      expect(await (await store()).readReady(url(1))).toBeNull();
      const published = join(publishedDirectory, '192.webp');
      const before = await fileState(published); // Proves injection ran after link, not during ancestor mkdir.
      vi.mocked(open).mockImplementation(native.open);
      expect(
        await runFixture(
          fixture,
          { ...options, resume: approved.runId },
          { encode },
        ),
      ).toMatchObject({ ready: 1, stopped: false });
      expect(await fileState(published)).toEqual(before);
    },
  );
  it('drains an active job, stops scheduling and requires explicit resume', async () => {
    options.batchSize = 5;
    const approved = await approve();
    const abort = new AbortController();
    const first = await runFixture(fixture, options, {
      encode,
      signal: abort.signal,
      beforeJournal: async () => {
        abort.abort();
      },
    });
    expect(first).toMatchObject({
      ready: 1,
      processed: 1,
      stopped: true,
      errorCode: 'INTERRUPTED',
    });
    expect(
      await runFixture(
        fixture,
        { ...options, resume: approved.runId },
        { encode },
      ),
    ).toMatchObject({ unchanged: 1, ready: 4, stopped: false });
  }, 15_000);
  it('halts after a source job failure instead of expanding scope', async () => {
    options.batchSize = 5;
    await approve();
    const decoder = vi.fn(async () => {
      throw new Error('Invalid source in fixture encoder');
    });
    const result = await runFixture(fixture, options, { encode: decoder });
    expect(result).toMatchObject({ processed: 1, stopped: true });
    expect(decoder).toHaveBeenCalledOnce();
    expect(await readdir(options.variantsRoot)).toEqual([]);
  });
  it('rechecks the complete inventory after encoding and refuses changed inputs before public writes', async () => {
    await approve();
    const result = await runFixture(fixture, options, {
      encode: async () => {
        await appendFile(options.inventory, JSON.stringify(rows[5]) + '\n');
        return generated;
      },
    });
    expect(result).toMatchObject({ stopped: true, processed: 1, ready: 0 });
    expect(await readdir(options.variantsRoot)).toEqual([]);
    expect(await (await store()).readReady(url(1))).toBeNull();
  });
  it('keeps production apply unconditionally blocked even with env assertions and valid approval', async () => {
    await approve();
    vi.stubEnv('IMAGE_SANDBOX_VERIFIED', 'true');
    vi.stubEnv('INVOCATION_ID', 'attestation-is-not-proof');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => requireProductionSandbox()).toThrow(
      expect.objectContaining({ code: 'SANDBOX_UNVERIFIED' }),
    );
    await expect(dryRun(options)).rejects.toMatchObject({
      code: 'SANDBOX_UNVERIFIED',
    });
    await expect(runFixture(fixture, options)).rejects.toMatchObject({
      code: 'FIXTURE_ONLY',
    });
    await emptyOutputs();
  });
  it('actual CLI defaults to dry-run and refuses apply before opening even a missing approval', async () => {
    const cli = fileURLToPath(new URL('./run.ts', import.meta.url));
    const before = await tree(fixture.root);
    const invoke = (extra: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', cli, ...args(), ...extra],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          windowsHide: true,
          timeout: 15_000,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env: {
            SystemRoot: process.env.SystemRoot,
            PATH: process.env.PATH,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            TMPDIR: process.env.TMPDIR,
            TSX_DISABLE_CACHE: '1',
            DATABASE_URL: 'must-not-use-db',
            IMAGE_SANDBOX_VERIFIED: 'true',
          },
        },
      );
    const dry = invoke([]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      mode: 'dry-run',
      productionApplyBlocked: true,
    });
    const applied = invoke([
      '--apply',
      '--approval',
      fixture.paths.approval!,
      '--approval-sha256',
      '0'.repeat(64),
    ]);
    expect(applied.status, applied.stderr).toBe(1);
    expect(JSON.parse(applied.stderr)).toEqual({ error: 'SANDBOX_UNVERIFIED' });
    expect(await tree(fixture.root)).toEqual(before);
  }, 30_000);
  it('preserves all restrictions of the existing test CLI', () => {
    const testPaths = [
      '--manifest',
      options.inventory,
      '--source-root',
      options.sourceRoot,
      '--variants-root',
      options.variantsRoot,
      '--state-root',
      options.stateRoot,
    ];
    expect(() => parseTestOptions([...testPaths, '--apply'])).toThrow(
      'Apply requires one explicit OS temp test sandbox',
    );
    expect(() => parseTestOptions([...testPaths, '--limit', '51'])).toThrow();
    expect(() =>
      parseTestOptions([...testPaths, '--concurrency', '3']),
    ).toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      validateTestOptions({ ...parseTestOptions(testPaths), apply: true }),
    ).toThrow('Production mode is forbidden');
  });
});
