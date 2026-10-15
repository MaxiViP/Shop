import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  unlink,
  writeFile,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ImageStorage, hash } from '../../src/product/image-storage.js';
import {
  generateImageVariants,
  type ImageVariants,
} from '../../src/product/image-variants.js';
import { backfill } from './backfill.js';
import { ImageJobError, supervisedEncode } from './encoder.js';
import { parseOptions, type BackfillOptions } from './options.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: vi.fn(native.open),
    rename: vi.fn(native.rename),
    link: vi.fn(native.link),
    statfs: vi.fn(native.statfs),
  };
});
const native =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let root: string;
let options: BackfillOptions;
let source: Buffer;
let generated: ImageVariants;
let originals: Map<string, Awaited<ReturnType<typeof fileState>>>;
const id = (index: number) =>
  '550e8400-e29b-41d4-a716-' + index.toString().padStart(12, '0');
const url = (index: number) => '/uploads/products/' + id(index) + '.webp';
const row = (index: number) => ({
  imageId: 'image-' + index,
  productId: 'product-' + index,
  url: url(index),
});
const fastEncode = async () => generated;
const inputPath = (index: number) =>
  join(options.sourceRoot, id(index) + '.webp');
const runPath = (runId: string, name: string) =>
  join(options.stateRoot, 'runs', runId, name);
const outputPath = (value: string) =>
  join(
    options.variantsRoot,
    ...value.slice('/uploads/products/'.length).split('/'),
  );
const store = () =>
  ImageStorage.open({
    sourceRoot: options.sourceRoot,
    publicRoot: options.variantsRoot,
    stateRoot: options.stateRoot,
  });
function assertTestRoot(target: string) {
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.startsWith(resolve(tmpdir()) + sep + 'korzina-image-backfill-')
  )
    throw new Error('Unsafe test cleanup');
}
async function fileState(path: string) {
  const bytes = await readFile(path);
  const info = await stat(path, { bigint: true });
  return {
    sha256: hash(bytes),
    bytes: bytes.length,
    ino: info.ino.toString(),
    mtime: info.mtimeNs.toString(),
  };
}
async function tree(path: string): Promise<unknown[]> {
  const info = await lstat(path, { bigint: true });
  const state: unknown[] = [path, info.ino.toString(), info.mtimeNs.toString()];
  if (info.isFile()) state.push(hash(await readFile(path)));
  if (info.isDirectory() && !info.isSymbolicLink())
    for (const name of (await readdir(path)).sort())
      state.push(await tree(join(path, name)));
  return state;
}
async function inventory(rows: unknown[]) {
  await writeFile(
    options.manifest,
    rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}
async function sources(count: number) {
  for (let index = 1; index <= count; index++) {
    await writeFile(inputPath(index), source, { flag: 'wx' });
    originals.set(inputPath(index), await fileState(inputPath(index)));
  }
  await inventory(Array.from({ length: count }, (_, index) => row(index + 1)));
}
const args = () => [
  '--manifest',
  options.manifest,
  '--source-root',
  options.sourceRoot,
  '--variants-root',
  options.variantsRoot,
  '--state-root',
  options.stateRoot,
];
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
  vi.mocked(link).mockReset().mockImplementation(native.link);
  vi.mocked(statfs).mockReset().mockImplementation(native.statfs);
  root = await mkdtemp(join(tmpdir(), 'korzina-image-backfill-'));
  options = {
    apply: true,
    manifest: join(root, 'inventory.jsonl'),
    sourceRoot: join(root, 'source'),
    variantsRoot: join(root, 'public'),
    stateRoot: join(root, 'state'),
    limit: 3,
    concurrency: 1,
  };
  for (const path of [
    options.sourceRoot,
    options.variantsRoot,
    options.stateRoot,
    join(root, 'outside'),
  ])
    await mkdir(path, { mode: 0o700 });
  await writeFile(join(root, 'outside', 'sentinel'), 'untouched', {
    flag: 'wx',
  });
  originals = new Map();
});
afterEach(async () => {
  try {
    for (const [path, before] of originals)
      expect(await fileState(path)).toEqual(before);
    expect(await readFile(join(root, 'outside', 'sentinel'), 'utf8')).toBe(
      'untouched',
    );
    expect(await readdir(join(root, 'outside'))).toEqual(['sentinel']);
  } finally {
    vi.mocked(open).mockImplementation(native.open);
    vi.mocked(rename).mockImplementation(native.rename);
    vi.mocked(link).mockImplementation(native.link);
    vi.mocked(statfs).mockImplementation(native.statfs);
    const target = resolve(root);
    assertTestRoot(target);
    await rm(target, { recursive: true, force: true });
  }
});

describe('offline image backfill', () => {
  it.each([
    ['--limit', '0'],
    ['--limit', 'NaN'],
    ['--limit', '51'],
    ['--concurrency', '3'],
    ['--concurrency', '1.5'],
    ['--resume', '../outside'],
    ['--unknown'],
    ['--apply', '--dry-run'],
    ['--limit', '3', '--limit', '3'],
  ])('rejects unsafe flags %j', async (...extra) => {
    expect(() => parseOptions([...args(), ...extra])).toThrow();
    expect(await readdir(options.stateRoot)).toEqual([]);
  });

  it('defaults to read-only and does not encode or create locks, dirs, logs or manifests', async () => {
    await sources(3);
    const before = await tree(root);
    const encode = vi.fn(fastEncode);
    const report = await backfill(parseOptions(args()), { encode });
    expect(report).toMatchObject({
      mode: 'dry-run',
      considered: 3,
      eligible: 3,
      sourceBytes: source.length * 3,
      stopped: false,
      runId: null,
    });
    expect(encode).not.toHaveBeenCalled();
    expect(await tree(root)).toEqual(before);
  });

  it('limits unique originals including ready/missing and does not refill scope with later rows', async () => {
    await sources(4);
    await unlink(inputPath(2));
    originals.delete(inputPath(2));
    await inventory([row(1), row(1), row(2), row(3), row(4)]);
    const first = await backfill(options, { encode: fastEncode });
    expect(first).toMatchObject({ considered: 3, ready: 2, skipped: 1 });
    const storage = await store();
    expect(await storage.readReady(url(4))).toBeNull();
    const paths = (await storage.readReady(url(1)))!.candidates.map((entry) =>
      outputPath(entry.url),
    );
    const before = await Promise.all(paths.map(fileState));
    const encode = vi.fn(fastEncode);
    const again = await backfill(options, { encode });
    expect(again).toMatchObject({ unchanged: 2, skipped: 1 });
    expect(encode).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map(fileState))).toEqual(before);
  });

  it('rejects malformed inventory and an unterminated inventory line before writing', async () => {
    await sources(1);
    for (const content of [
      '{"url":\n',
      JSON.stringify(row(1)),
      JSON.stringify({ ...row(1), path: '../outside' }) + '\n',
    ]) {
      await writeFile(options.manifest, content);
      await expect(backfill(options)).rejects.toBeDefined();
      expect(await readdir(options.stateRoot)).toEqual([]);
    }
  });

  it('skips external/traversal URLs without network or filesystem resolution', async () => {
    await sources(1);
    const invalid = [
      'https://example.com/a.webp',
      '/uploads/products/../outside.webp',
      '/uploads/products/%2e%2e.webp',
    ];
    await inventory(
      invalid.map((value, index) => ({ ...row(index + 1), url: value })),
    );
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const report = await backfill(options);
      expect(report).toMatchObject({ skipped: 3, ready: 0, stopped: false });
      expect(report.errors.every((entry) => entry.code === 'INVALID_URL')).toBe(
        true,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(options.variantsRoot)).toEqual([]);
    } finally {
      fetch.mockRestore();
    }
  });

  it('reports unsupported, missing, corrupt and oversized inputs without manufacturing readiness', async () => {
    await sources(4);
    await writeFile(inputPath(1), '<svg>unsupported</svg>');
    await unlink(inputPath(2));
    await writeFile(inputPath(3), 'RIFFbrokenWEBP');
    await writeFile(inputPath(4), Buffer.alloc(5 * 1024 * 1024 + 1));
    originals.clear();
    for (const index of [1, 3, 4])
      originals.set(inputPath(index), await fileState(inputPath(index)));
    const report = await backfill({ ...options, limit: 4 });
    expect(report).toMatchObject({
      failed: 2,
      skipped: 2,
      ready: 0,
      stopped: false,
    });
    expect(await readdir(options.variantsRoot)).toEqual([]);
  });

  it.each(['sourceRoot', 'stateRoot', 'variantsRoot'] as const)(
    'rejects overlapping roots at %s',
    async (key) => {
      await sources(1);
      const values = {
        ...options,
        [key]: key === 'stateRoot' ? options.sourceRoot : options.stateRoot,
      };
      await expect(backfill(values)).rejects.toBeDefined();
      expect(await readdir(options.stateRoot)).toEqual([]);
    },
  );

  it('refuses apply outside the OS temp sandbox and in production mode', async () => {
    await sources(1);
    expect(() =>
      parseOptions([...args().slice(0, -1), resolve('uploads'), '--apply']),
    ).toThrow();
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await expect(backfill(options)).rejects.toBeDefined();
      expect(await readdir(options.stateRoot)).toEqual([]);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it.each([
    'sourceRoot',
    'variantsRoot',
    'stateRoot',
    'manifest parent',
  ] as const)(
    'rejects a symlink/junction at %s without following it',
    async (key) => {
      await sources(1);
      const alias = join(root, 'alias');
      await symlink(
        join(root, 'outside'),
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const values =
        key === 'manifest parent'
          ? { ...options, manifest: join(alias, 'inventory.jsonl') }
          : { ...options, [key]: alias };
      await expect(backfill(values)).rejects.toBeDefined();
      expect(await readdir(options.stateRoot)).toEqual([]);
    },
  );

  it('rejects a junction in a variant destination instead of exposing data outside the variant root', async () => {
    await sources(1);
    await symlink(
      join(root, 'outside'),
      join(options.variantsRoot, 'variants'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const report = await backfill(options, { encode: fastEncode });
    expect(report).toMatchObject({ stopped: true, errorCode: 'INVALID_PATH' });
  });

  it.each([0, 1, 2])(
    'resumes interruption after %i published files, reusing correct bytes and mtime',
    async (published) => {
      await sources(1);
      let links = 0;
      vi.mocked(link).mockImplementation(async (temp, destination) => {
        if (links++ === published)
          throw Object.assign(new Error('Interrupted'), { code: 'EIO' });
        await native.link(temp, destination);
      });
      const interrupted = await backfill(options, { encode: fastEncode });
      expect(interrupted.stopped).toBe(true);
      const storage = await store();
      expect(await storage.readReady(url(1))).toBeNull();
      const kept = generated.variants
        .slice(0, published)
        .map((entry) =>
          join(
            options.variantsRoot,
            'variants',
            'v1',
            id(1),
            hash(source),
            entry.sizes[0] + '.webp',
          ),
        );
      const before = await Promise.all(kept.map(fileState));
      vi.mocked(link).mockImplementation(native.link);
      const recovered = await backfill(
        { ...options, resume: interrupted.runId! },
        { encode: fastEncode },
      );
      expect(recovered).toMatchObject({ ready: 1, stopped: false });
      expect(await Promise.all(kept.map(fileState))).toEqual(before);
      expect(await storage.readReady(url(1))).not.toBeNull();
    },
  );

  it('resumes an interruption before READY without rewriting published variants', async () => {
    await sources(1);
    let failed = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (!failed && String(to).includes(sep + 'ready' + sep)) {
        failed = true;
        throw Object.assign(new Error('Interrupted'), { code: 'EIO' });
      }
      await native.rename(from, to);
    });
    const first = await backfill(options, { encode: fastEncode });
    expect(first.stopped).toBe(true);
    const before = await tree(options.variantsRoot);
    const second = await backfill(
      { ...options, resume: first.runId! },
      { encode: fastEncode },
    );
    expect(second).toMatchObject({ ready: 1, stopped: false });
    expect(await tree(options.variantsRoot)).toEqual(before);
  });

  it('recovers READY published before journal append and rechecks completed runs on every resume', async () => {
    await sources(1);
    const first = await backfill(options, {
      encode: fastEncode,
      beforeJournal: async () => {
        throw new Error('Crash before journal');
      },
    });
    expect(first.stopped).toBe(true);
    expect(
      (await readFile(runPath(first.runId!, 'journal.jsonl'))).length,
    ).toBe(0);
    const storage = await store();
    const manifest = (await storage.readReady(url(1)))!;
    const paths = [
      ...manifest.candidates.map((entry) => outputPath(entry.url)),
      join(options.stateRoot, 'ready', id(1) + '.json'),
    ];
    const before = await Promise.all(paths.map(fileState));
    const encode = vi.fn(fastEncode);
    for (let repeat = 0; repeat < 2; repeat++)
      expect(
        await backfill({ ...options, resume: first.runId! }, { encode }),
      ).toMatchObject({ unchanged: 1, stopped: false });
    expect(encode).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map(fileState))).toEqual(before);
    await unlink(paths[0]!);
    expect(
      await backfill(
        { ...options, resume: first.runId! },
        { encode: fastEncode },
      ),
    ).toMatchObject({ ready: 1 });
    expect(await Promise.all(paths.slice(1, -1).map(fileState))).toEqual(
      before.slice(1, -1),
    );
  });

  it('ignores only a torn final journal line, leaves dry-run unchanged, and repairs the tail under the run lock', async () => {
    await sources(1);
    const first = await backfill(options, { encode: fastEncode });
    const path = runPath(first.runId!, 'journal.jsonl');
    await writeFile(path, '{"schemaVersion":', { flag: 'a' });
    const before = await tree(root);
    expect(
      await backfill({ ...options, apply: false, resume: first.runId! }),
    ).toMatchObject({ unchanged: 1 });
    expect(await tree(root)).toEqual(before);
    expect(await backfill({ ...options, resume: first.runId! })).toMatchObject({
      unchanged: 1,
    });
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it.each(['journal', 'checkpoint'])(
    'refuses corrupt %s and never trusts journal success as readiness',
    async (kind) => {
      await sources(1);
      const first = await backfill(options, { encode: fastEncode });
      const path = runPath(
        first.runId!,
        kind === 'journal' ? 'journal.jsonl' : 'checkpoint.json',
      );
      if (kind === 'journal')
        await writeFile(path, '{}\n{"broken":\n{}\n', { flag: 'a' });
      else {
        const checkpoint = JSON.parse(await readFile(path, 'utf8')) as {
          cursor: number;
        };
        checkpoint.cursor = 0;
        await writeFile(path, JSON.stringify(checkpoint));
      }
      const before = await tree(root);
      await expect(
        backfill({ ...options, apply: false, resume: first.runId! }),
      ).rejects.toBeDefined();
      expect(await tree(root)).toEqual(before);
    },
  );

  it('rejects changed inventory, explicit scope expansion and changed roots on resume', async () => {
    await sources(2);
    const first = await backfill(
      { ...options, limit: 1 },
      { encode: fastEncode },
    );
    await expect(
      backfill({ ...options, resume: first.runId!, limit: 2 }),
    ).rejects.toBeDefined();
    const alternate = join(root, 'alternate');
    await mkdir(alternate);
    await expect(
      backfill({
        ...options,
        limit: 1,
        resume: first.runId!,
        variantsRoot: alternate,
      }),
    ).rejects.toBeDefined();
    await writeFile(options.manifest, JSON.stringify(row(3)) + '\n', {
      flag: 'a',
    });
    await expect(
      backfill({ ...options, limit: 1, resume: first.runId! }),
    ).rejects.toBeDefined();
  });

  it('does not process a changed original within the old frozen scope', async () => {
    await sources(1);
    const first = await backfill(options, { encode: fastEncode });
    const before = await tree(options.variantsRoot);
    await writeFile(
      inputPath(1),
      await sharp({
        create: { width: 64, height: 32, channels: 3, background: 'red' },
      })
        .webp()
        .toBuffer(),
    );
    originals.set(inputPath(1), await fileState(inputPath(1)));
    const encode = vi.fn(fastEncode);
    const resumed = await backfill(
      { ...options, resume: first.runId! },
      { encode },
    );
    expect(resumed).toMatchObject({
      skipped: 1,
      stopped: false,
      errors: [{ index: 0, code: 'SOURCE_CHANGED' }],
    });
    expect(encode).not.toHaveBeenCalled();
    expect(await tree(options.variantsRoot)).toEqual(before);
  });

  it('bounds concurrency and records a contiguous cursor when later jobs finish first', async () => {
    await sources(3);
    const secondSource = await sharp({
      create: { width: 960, height: 720, channels: 3, background: 'blue' },
    })
      .webp()
      .toBuffer();
    const secondGenerated = await generateImageVariants(secondSource);
    await writeFile(inputPath(2), secondSource);
    originals.set(inputPath(2), await fileState(inputPath(2)));
    let resume!: () => void;
    let entered!: () => void;
    let releaseEncoders!: () => void;
    const gate = new Promise<void>((done) => {
      resume = done;
    });
    const active = new Promise<void>((done) => {
      entered = done;
    });
    const encodersGate = new Promise<void>((done) => {
      releaseEncoders = done;
    });
    let calls = 0;
    let encoders = 0;
    let peakEncoders = 0;
    let runId = '';
    const running = backfill(
      { ...options, concurrency: 2 },
      {
        onRun: (value) => {
          runId = value;
        },
        encode: async (buffer) => {
          encoders++;
          peakEncoders = Math.max(peakEncoders, encoders);
          try {
            if (++calls === 2) entered();
            await encodersGate;
            if (buffer.equals(source)) await gate;
            return buffer.equals(source) ? generated : secondGenerated;
          } finally {
            encoders--;
          }
        },
      },
    );
    await active;
    try {
      expect(calls).toBe(2);
      expect(peakEncoders).toBe(2);
      releaseEncoders();
      await vi.waitFor(
        async () => {
          const checkpoint = JSON.parse(
            await readFile(runPath(runId, 'checkpoint.json'), 'utf8'),
          ) as { cursor: number; completed: number[] };
          expect(checkpoint.cursor).toBe(0);
          expect(checkpoint.completed).toContain(1);
        },
        { timeout: 10_000 },
      );
      await expect(
        backfill({ ...options, resume: runId }),
      ).rejects.toMatchObject({ code: 'BUSY' });
    } finally {
      releaseEncoders();
      resume();
      await running;
    }
    expect(await running).toMatchObject({ ready: 3, stopped: false });
    expect(peakEncoders).toBe(2);
  });

  it.each(['direct', 'work ancestor'] as const)(
    'stops scheduling after a system write error with %s roots without deleting files',
    async (location) => {
      if (location === 'work ancestor') {
        const parent = join(root, 'work');
        await mkdir(parent, { mode: 0o700 });
        const stateRoot = join(parent, 'state');
        await native.rename(options.stateRoot, stateRoot);
        options.stateRoot = stateRoot;
      }
      await sources(3);
      vi.mocked(open).mockImplementation(async (path, flags, mode) => {
        if (
          String(path).startsWith(join(options.stateRoot, 'work') + sep) &&
          typeof flags === 'number' &&
          flags & constants.O_CREAT
        )
          throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
        return native.open(path, flags, mode);
      });
      const encode = vi.fn(fastEncode);
      const report = await backfill(options, { encode });
      expect(encode).toHaveBeenCalledOnce();
      expect(report).toMatchObject({
        stopped: true,
        processed: 1,
        errorCode: 'IO',
      });
      expect(
        (await readdir(options.variantsRoot, { recursive: true })).some(
          (path) => path.endsWith('.webp'),
        ),
      ).toBe(false);
    },
  );

  it('refuses disk admission before creating run state', async () => {
    await sources(1);
    vi.mocked(statfs).mockImplementation(async (path) => {
      const value = await native.statfs(path, { bigint: true });
      return { ...value, bavail: 0n };
    });
    await expect(backfill(options)).rejects.toBeDefined();
    expect(await readdir(options.stateRoot)).toEqual([]);
    expect(await readdir(options.variantsRoot)).toEqual([]);
  });

  it('does not truncate a journal hard-linked to another file', async () => {
    await sources(1);
    const first = await backfill(options, { encode: fastEncode });
    const journal = runPath(first.runId!, 'journal.jsonl');
    const alias = join(root, 'journal-alias');
    await native.link(journal, alias);
    const before = await fileState(alias);
    await expect(
      backfill({ ...options, resume: first.runId! }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(await fileState(alias)).toEqual(before);
  });

  it('does not steal an unknown run lock on resume', async () => {
    await sources(1);
    const first = await backfill(options, { encode: fastEncode });
    const lock = runPath(first.runId!, 'run.lock');
    await writeFile(lock, '{"pid":1,"token":"unknown"}', { flag: 'wx' });
    const before = await fileState(lock);
    await expect(
      backfill({ ...options, resume: first.runId! }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(await fileState(lock)).toEqual(before);
  });

  it.skipIf(process.platform !== 'linux').each(['source', 'manifest'] as const)(
    'Linux: rejects a native file symlink at %s',
    async (location) => {
      await sources(1);
      const target = location === 'source' ? inputPath(1) : options.manifest;
      const saved = join(root, 'saved-file');
      await native.rename(target, saved);
      originals.delete(target);
      originals.set(saved, await fileState(saved));
      await symlink(saved, target, 'file');
      const before = await tree(root);
      await expect(backfill(options)).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
      expect(await tree(root)).toEqual(before);
    },
  );

  it('drains the active job on graceful interruption and resumes the remaining scope', async () => {
    await sources(3);
    const abort = new AbortController();
    const first = await backfill(options, {
      encode: fastEncode,
      signal: abort.signal,
      beforeJournal: async () => {
        abort.abort();
      },
    });
    expect(first).toMatchObject({
      processed: 1,
      ready: 1,
      stopped: true,
      errorCode: 'INTERRUPTED',
    });
    const second = await backfill(
      { ...options, resume: first.runId! },
      { encode: fastEncode },
    );
    expect(second).toMatchObject({ unchanged: 1, ready: 2, stopped: false });
  });

  it('uses supervised children for three repository photo copies, verifies sizes and reports comparable profile bytes', async () => {
    const samples = [
      'vkusnaya-stall/vkusnaya-stall-stuffed-peppers-500g.webp',
      'oktyabrskoe-moloko/oktyabrskoe-moloko-milk-32-1l.webp',
      'borisovskie-syry/borisovskie-syry-brie-200-250g.webp',
    ];
    for (const [index, sample] of samples.entries()) {
      await copyFile(
        new URL('../product-photos/2026-10-07/' + sample, import.meta.url),
        inputPath(index + 1),
        constants.COPYFILE_EXCL,
      );
      originals.set(
        inputPath(index + 1),
        await fileState(inputPath(index + 1)),
      );
    }
    await inventory([row(1), row(2), row(3)]);
    const before = await tree(root);
    const cli = fileURLToPath(new URL('./run.ts', import.meta.url));
    const dry = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', cli, ...args()],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, TSX_DISABLE_CACHE: '1' },
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(JSON.parse(dry.stdout)).toMatchObject({
      mode: 'dry-run',
      considered: 3,
      eligible: 3,
    });
    expect(await tree(root)).toEqual(before);
    const report = await backfill(options);
    expect(report).toMatchObject({
      ready: 3,
      failed: 0,
      skipped: 0,
      stopped: false,
    });
    expect(report.workerPeakRss).toBeGreaterThan(0);
    expect(report.originalBytes).toBe(
      [...originals.values()].reduce((sum, value) => sum + value.bytes, 0),
    );
    const storage = await store();
    const totals = [0, 0, 0];
    for (let index = 1; index <= 3; index++) {
      const manifest = (await storage.readReady(url(index)))!;
      for (const [profileIndex, size] of ([192, 384, 640] as const).entries()) {
        const candidate = manifest.candidates.find((entry) =>
          entry.sizes.includes(size),
        )!;
        const data = await readFile(outputPath(candidate.url));
        expect(hash(data)).toBe(candidate.sha256);
        expect(await sharp(data).metadata()).toMatchObject({
          width: candidate.width,
          height: candidate.height,
          format: 'webp',
        });
        totals[profileIndex]! += data.length;
      }
    }
    expect(report.profiles.map((entry) => entry.bytes)).toEqual(totals);
    expect(report.profiles.every((entry) => entry.reductionPercent! > 0)).toBe(
      true,
    );
    const files = await tree(options.variantsRoot);
    expect(await backfill(options)).toMatchObject({
      unchanged: 3,
      workerPeakRss: 0,
    });
    expect(await tree(options.variantsRoot)).toEqual(files);
  }, 30_000);

  it('kills a timed-out encoder and waits for child exit before rejecting', async () => {
    await expect(
      supervisedEncode(source, () => {}, {
        timeoutMs: 1,
        rssBytes: 512 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('stops an encoder exceeding its sampled RSS budget', async () => {
    await expect(
      supervisedEncode(source, () => {}, { timeoutMs: 10_000, rssBytes: 1 }),
    ).rejects.toBeInstanceOf(ImageJobError);
  });
});
