import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { imageVariantUrl, parseImageManifest } from './image-manifest.js';
import { ImageStorage, ImageStorageError } from './image-storage.js';
import { generateImageVariants, type ImageVariants } from './image-variants.js';

// Fault injection wraps the native filesystem. Hard links, junctions, rename
// and all successful I/O still execute on the host OS, without POSIX emulation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    rename: vi.fn(actual.rename),
    open: vi.fn(actual.open),
  };
});
const native =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const id = '550e8400-e29b-41d4-a716-446655440000';
const url = `/uploads/products/${id}.webp`;
const hash = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');
let source: Buffer;
let generated: ImageVariants;
let root: string;
let publicRoot: string;
let stateRoot: string;
let outside: string;
let storage: ImageStorage;
let originalPath: string;
let originalState: Awaited<ReturnType<typeof fileState>>;
let preserveOriginal: boolean;

async function fileState(path: string) {
  const bytes = await readFile(path);
  const info = await stat(path, { bigint: true });
  return {
    bytes,
    sha256: hash(bytes),
    mtimeNs: info.mtimeNs,
    ino: info.ino,
    size: info.size,
  };
}
const outputPath = (variantUrl: string) =>
  join(publicRoot, ...variantUrl.slice('/uploads/products/'.length).split('/'));
const readyPath = () => join(stateRoot, 'ready', `${id}.json`);
const cloneGenerated = (): ImageVariants => ({
  ...generated,
  source: { ...generated.source },
  variants: generated.variants.map((variant) => ({
    ...variant,
    sizes: [...variant.sizes],
    buffer: Buffer.from(variant.buffer),
  })),
});

beforeAll(async () => {
  source = await sharp({
    create: { width: 960, height: 720, channels: 3, background: '#5a83ad' },
  })
    .webp({ quality: 95 })
    .toBuffer();
  generated = await generateImageVariants(source);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(link).mockReset().mockImplementation(native.link);
  vi.mocked(rename).mockReset().mockImplementation(native.rename);
  vi.mocked(open).mockReset().mockImplementation(native.open);
  root = await mkdtemp(join(tmpdir(), 'korzina-image-storage-test-'));
  publicRoot = join(root, 'products');
  stateRoot = join(root, 'state');
  outside = join(root, 'outside');
  for (const path of [publicRoot, stateRoot, outside])
    await mkdir(path, { mode: 0o700 });
  originalPath = join(publicRoot, `${id}.webp`);
  await writeFile(originalPath, source, { flag: 'wx' });
  originalState = await fileState(originalPath);
  preserveOriginal = true;
  storage = await ImageStorage.open({ publicRoot, stateRoot });
});

afterEach(async () => {
  try {
    if (preserveOriginal) {
      const after = await fileState(originalPath);
      expect(after.bytes.equals(originalState.bytes)).toBe(true);
      expect({ ...after, bytes: undefined }).toEqual({
        ...originalState,
        bytes: undefined,
      });
    }
  } finally {
    vi.mocked(link).mockImplementation(native.link);
    vi.mocked(rename).mockImplementation(native.rename);
    vi.mocked(open).mockImplementation(native.open);
    const target = resolve(root);
    assertTestRoot(target);
    await rm(target, { recursive: true, force: true });
  }
});

function assertTestRoot(target: string) {
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !target.startsWith(resolve(tmpdir()) + sep + 'korzina-image-storage-test-')
  )
    throw new Error('Unsafe test directory');
}

describe('product image storage', () => {
  it('refuses a source version changed since the frozen backfill snapshot', async () => {
    const expected = (await storage.version(url))!;
    await writeFile(
      originalPath,
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: 'red' },
      })
        .webp()
        .toBuffer(),
    );
    originalState = await fileState(originalPath);
    const encode = vi.fn(generateImageVariants);
    await expect(storage.save(url, encode, expected)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    expect(encode).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect(await storage.readReady(url)).toBeNull();
  });

  it('supports disjoint source, variants and state roots without copying originals', async () => {
    const variantsRoot = join(root, 'variants');
    await mkdir(variantsRoot, { mode: 0o700 });
    const separate = await ImageStorage.open({
      sourceRoot: publicRoot,
      publicRoot: variantsRoot,
      stateRoot,
    });
    const result = await separate.save(url);
    expect(await separate.readReady(url)).toEqual(result.manifest);
    expect(await readdir(publicRoot)).toEqual([`${id}.webp`]);
    await expect(stat(join(variantsRoot, `${id}.webp`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const candidate of result.manifest.candidates)
      await sharp(
        await readFile(
          join(
            variantsRoot,
            ...candidate.url.slice('/uploads/products/'.length).split('/'),
          ),
        ),
      ).stats();
  });

  it.each(['same', 'nested', 'state'] as const)(
    'rejects an explicit source root overlapping %s',
    async (kind) => {
      await expect(
        ImageStorage.open({
          publicRoot,
          stateRoot,
          sourceRoot:
            kind === 'same'
              ? publicRoot
              : kind === 'nested'
                ? join(publicRoot, 'sources')
                : stateRoot,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    },
  );

  it('opens and checks an absent ready set without creating files or directories', async () => {
    expect(await readdir(stateRoot)).toEqual([]);
    expect(await storage.readReady(url)).toBeNull();
    expect(await readdir(stateRoot)).toEqual([]);
    expect(await readdir(publicRoot)).toEqual([`${id}.webp`]);
  });

  it('stores a tiny UUID v8 source once for all three bounding sizes', async () => {
    const tinyId = '550e8400-e29b-81d4-a716-446655440000';
    const tinyUrl = `/uploads/products/${tinyId}.webp`;
    const path = join(publicRoot, `${tinyId}.webp`);
    await sharp({
      create: { width: 80, height: 40, channels: 3, background: 'green' },
    })
      .webp()
      .toFile(path);
    const before = await fileState(path);
    const result = await storage.save(tinyUrl);
    expect(result.manifest.candidates).toHaveLength(1);
    expect(result.manifest.candidates[0]).toMatchObject({
      sizes: [192, 384, 640],
      width: 80,
      height: 40,
    });
    expect(await storage.readReady(tinyUrl)).toEqual(result.manifest);
    expect(await fileState(path)).toEqual(before);
  });
  it('publishes fully verified 192/384/640 with native no-clobber hard links and a private manifest last', async () => {
    const linked: string[] = [];
    vi.mocked(link).mockImplementation(async (temp, destination) => {
      expect(String(temp).startsWith(stateRoot + sep)).toBe(true);
      await native.link(temp, destination);
      const staged = await stat(temp, { bigint: true });
      const published = await stat(destination, { bigint: true });
      expect(published.ino).toBe(staged.ino);
      expect(published.dev).toBe(staged.dev);
      linked.push(String(destination));
    });
    vi.mocked(rename).mockImplementation(async (temp, destination) => {
      expect(linked).toHaveLength(3);
      expect(String(temp).startsWith(stateRoot + sep)).toBe(true);
      expect(destination).toBe(readyPath());
      for (const path of linked) await sharp(await readFile(path)).stats();
      await native.rename(temp, destination);
    });
    const result = await storage.save(url);
    expect(result.status).toBe('READY');
    expect(result.conflicts).toEqual([]);
    expect(
      result.manifest.candidates.map((candidate) => candidate.sizes),
    ).toEqual([[192], [384], [640]]);
    for (const candidate of result.manifest.candidates) {
      const buffer = await readFile(outputPath(candidate.url));
      const metadata = await sharp(buffer).metadata();
      expect(hash(buffer)).toBe(candidate.sha256);
      expect(buffer.length).toBe(candidate.bytes);
      expect(metadata).toMatchObject({
        format: 'webp',
        width: candidate.width,
        height: candidate.height,
      });
    }
    expect(parseImageManifest(await readFile(readyPath()))).toEqual(
      result.manifest,
    );
    expect(await storage.readReady(url)).toEqual(result.manifest);
    expect(
      (await readdir(publicRoot, { recursive: true })).some((path) =>
        path.endsWith('.json'),
      ),
    ).toBe(false);
    expect(JSON.stringify(result.manifest)).not.toContain(root);
    expect(await readdir(join(stateRoot, 'locks'))).toEqual([]);
  });

  it('repeats without encoding or changing bytes, hashes, inodes and mtime of files or manifest', async () => {
    const first = await storage.save(url);
    const paths = [
      ...first.manifest.candidates.map((candidate) =>
        outputPath(candidate.url),
      ),
      readyPath(),
    ];
    const before = await Promise.all(paths.map(fileState));
    const encode = vi.fn(generateImageVariants);
    const second = await storage.save(url, encode);
    expect(second).toEqual({
      status: 'UNCHANGED',
      manifest: first.manifest,
      conflicts: [],
    });
    expect(encode).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map(fileState))).toEqual(before);
  });

  it.each([
    '../outside/photo.webp',
    `/uploads/products/../${id}.webp`,
    `/uploads/products/%2e%2e/${id}.webp`,
    `/uploads/products/${id}.webp?file=secret`,
    `/uploads/products\\${id}.webp`,
    `/uploads/products/${id}.webp\0`,
    `/uploads/products/${id}.webp\n`,
    `https://example.com/${id}.webp`,
  ])(
    'rejects traversal or noncanonical source %j before generation',
    async (input) => {
      const encode = vi.fn(generateImageVariants);
      await expect(storage.save(input, encode)).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
      await expect(storage.readReady(input)).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
      expect(encode).not.toHaveBeenCalled();
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it.each([
    'equal',
    'private inside public',
    'public inside private',
    'relative',
  ] as const)('rejects overlapping or invalid roots: %s', async (kind) => {
    const roots =
      kind === 'equal'
        ? { publicRoot, stateRoot: publicRoot }
        : kind === 'private inside public'
          ? { publicRoot, stateRoot: join(publicRoot, 'state') }
          : kind === 'public inside private'
            ? { publicRoot: join(stateRoot, 'products'), stateRoot }
            : { publicRoot: 'products', stateRoot };
    await expect(ImageStorage.open(roots)).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    expect(await readdir(publicRoot)).toEqual([`${id}.webp`]);
  });

  it('does not confuse sibling path prefixes with nested roots', async () => {
    const privateSibling = publicRoot + '-private';
    await mkdir(privateSibling, { mode: 0o700 });
    expect(
      await ImageStorage.open({ publicRoot, stateRoot: privateSibling }),
    ).toBeInstanceOf(ImageStorage);
  });

  it.each([
    'public root',
    'state root',
    'variant parent',
    'staging parent',
    'ready parent',
  ] as const)(
    'rejects symlink/junction at %s without touching its target',
    async (location) => {
      const junctionType = process.platform === 'win32' ? 'junction' : 'dir';
      if (location === 'public root' || location === 'state root') {
        const alias = join(root, 'alias');
        await symlink(outside, alias, junctionType);
        await expect(
          ImageStorage.open(
            location === 'public root'
              ? { publicRoot: alias, stateRoot }
              : { publicRoot, stateRoot: alias },
          ),
        ).rejects.toMatchObject({ code: 'INVALID_PATH' });
      } else {
        const path =
          location === 'variant parent'
            ? join(publicRoot, 'variants')
            : location === 'staging parent'
              ? join(stateRoot, 'work', id)
              : join(stateRoot, 'ready');
        if (location === 'staging parent') await mkdir(join(stateRoot, 'work'));
        await symlink(outside, path, junctionType);
        await expect(storage.save(url)).rejects.toMatchObject({
          code: 'INVALID_PATH',
        });
      }
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it('rejects a root replaced after opening storage', async () => {
    const moved = join(root, 'old-products');
    await native.rename(publicRoot, moved);
    originalPath = join(moved, `${id}.webp`);
    await mkdir(publicRoot);
    await expect(storage.save(url)).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('does not declare missing output ready and recreates only the missing file on disk', async () => {
    const first = await storage.save(url);
    const [missing, ...kept] = first.manifest.candidates;
    const states = await Promise.all(
      kept.map((candidate) => fileState(outputPath(candidate.url))),
    );
    await unlink(outputPath(missing!.url));
    expect(await storage.readReady(url)).toBeNull();
    const second = await storage.save(url);
    expect(await storage.readReady(url)).toEqual(second.manifest);
    expect(
      await Promise.all(
        kept.map((candidate) => fileState(outputPath(candidate.url))),
      ),
    ).toEqual(states);
  });

  it('repairs a corrupt immutable file under a new checksum URL, preserving all existing files', async () => {
    const first = await storage.save(url);
    const [broken, ...kept] = first.manifest.candidates;
    const states = await Promise.all(
      kept.map((candidate) => fileState(outputPath(candidate.url))),
    );
    await writeFile(outputPath(broken!.url), 'broken original variant');
    const brokenState = await fileState(outputPath(broken!.url));
    expect(await storage.readReady(url)).toBeNull();
    const repaired = await storage.save(url);
    expect(repaired.conflicts).toEqual([broken!.url]);
    expect(repaired.manifest.candidates[0]!.url).toBe(
      imageVariantUrl(id, hash(source), 192, broken!.sha256),
    );
    expect(await fileState(outputPath(broken!.url))).toEqual(brokenState);
    expect(
      await Promise.all(
        kept.map((candidate) => fileState(outputPath(candidate.url))),
      ),
    ).toEqual(states);
    expect(await storage.readReady(url)).toEqual(repaired.manifest);
    expect((await storage.save(url)).status).toBe('UNCHANGED');
  });

  it('preserves a valid conflicting WebP instead of overwriting its immutable URL', async () => {
    const destination = outputPath(imageVariantUrl(id, hash(source), 192));
    await mkdir(dirname(destination), { recursive: true });
    await sharp({
      create: { width: 192, height: 144, channels: 3, background: 'red' },
    })
      .webp()
      .toFile(destination);
    const before = await fileState(destination);
    const result = await storage.save(url);
    expect(result.conflicts).toHaveLength(1);
    expect(result.manifest.candidates[0]!.url).toContain(
      `-${generated.variants[0]!.sha256}.webp`,
    );
    expect(await fileState(destination)).toEqual(before);
  });

  it('fails closed when a deterministic repair destination also conflicts', async () => {
    const canonical = outputPath(imageVariantUrl(id, hash(source), 192));
    const repair = outputPath(
      imageVariantUrl(id, hash(source), 192, generated.variants[0]!.sha256),
    );
    await mkdir(dirname(canonical), { recursive: true });
    await writeFile(canonical, 'canonical conflict', { flag: 'wx' });
    await writeFile(repair, 'repair conflict', { flag: 'wx' });
    const before = await Promise.all([canonical, repair].map(fileState));
    await expect(storage.save(url)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Promise.all([canonical, repair].map(fileState))).toEqual(
      before,
    );
    expect(await storage.readReady(url)).toBeNull();
  });

  it('a failed private write keeps the original intact and publishes no manifest', async () => {
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (
        String(path).includes(sep + 'work' + sep) &&
        typeof flags === 'number' &&
        flags & constants.O_CREAT
      )
        throw Object.assign(new Error('ENOSPC /private/secret-contents'), {
          code: 'ENOSPC',
        });
      return native.open(path, flags, mode);
    });
    await expect(storage.save(url)).rejects.toMatchObject({
      code: 'IO',
      message: 'Product image storage operation failed',
    });
    expect(await storage.readReady(url)).toBeNull();
    expect(await readdir(join(stateRoot, 'locks'))).toEqual([]);
  });

  it('interruption before manifest publication preserves outputs and recovers without rewriting them', async () => {
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error('Interrupted metadata publication'), {
        code: 'EIO',
      }),
    );
    await expect(storage.save(url)).rejects.toMatchObject({ code: 'IO' });
    expect(await storage.readReady(url)).toBeNull();
    await expect(stat(readyPath())).rejects.toMatchObject({ code: 'ENOENT' });
    const paths = generated.variants.map((variant) =>
      outputPath(imageVariantUrl(id, hash(source), variant.sizes[0]!)),
    );
    const before = await Promise.all(paths.map(fileState));
    const privateFiles = await readdir(stateRoot, { recursive: true });
    expect(privateFiles.some((path) => path.endsWith('manifest.json'))).toBe(
      true,
    );
    const restarted = await ImageStorage.open({ publicRoot, stateRoot });
    expect((await restarted.save(url)).status).toBe('READY');
    expect(await Promise.all(paths.map(fileState))).toEqual(before);
    expect((await restarted.save(url)).status).toBe('UNCHANGED');
  });

  it('recovers a partial publication and keeps the first already published file unchanged', async () => {
    let count = 0;
    vi.mocked(link).mockImplementation(async (temp, destination) => {
      if (++count === 2)
        throw Object.assign(new Error('Interrupted'), { code: 'EINTR' });
      await native.link(temp, destination);
    });
    await expect(storage.save(url)).rejects.toMatchObject({ code: 'IO' });
    expect(await storage.readReady(url)).toBeNull();
    const firstPath = outputPath(imageVariantUrl(id, hash(source), 192));
    const before = await fileState(firstPath);
    vi.mocked(link).mockImplementation(native.link);
    expect((await storage.save(url)).status).toBe('READY');
    expect(await fileState(firstPath)).toEqual(before);
    expect((await storage.save(url)).status).toBe('UNCHANGED');
  });

  it('does not delete an old valid manifest when Windows/native replacement fails', async () => {
    await storage.save(url);
    const before = await fileState(readyPath());
    const manifest = parseImageManifest(before.bytes);
    await writeFile(outputPath(manifest.candidates[0]!.url), 'damaged');
    vi.mocked(rename).mockRejectedValueOnce(
      Object.assign(new Error('File locked'), { code: 'EPERM' }),
    );
    await expect(storage.save(url)).rejects.toMatchObject({ code: 'IO' });
    expect(await fileState(readyPath())).toEqual(before);
    expect(await storage.readReady(url)).toBeNull();
    expect((await storage.save(url)).status).toBe('READY');
  });

  it('serializes concurrent storage instances with an exclusive per-source lock', async () => {
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const gate = new Promise<void>((done) => {
      resume = done;
    });
    const first = storage.save(url, async (buffer) => {
      enter();
      await gate;
      return generateImageVariants(buffer);
    });
    await entered;
    try {
      const second = await ImageStorage.open({ publicRoot, stateRoot });
      await expect(second.save(url)).rejects.toMatchObject({ code: 'BUSY' });
    } finally {
      resume();
    }
    const result = await first;
    expect(await storage.readReady(url)).toEqual(result.manifest);
    expect((await storage.save(url)).status).toBe('UNCHANGED');
  });

  it('validates the winner of a native EEXIST race without overwriting it', async () => {
    let winner: Awaited<ReturnType<typeof fileState>> | undefined;
    vi.mocked(link).mockImplementationOnce(async (_temp, destination) => {
      await native.writeFile(destination, generated.variants[0]!.buffer, {
        flag: 'wx',
      });
      winner = await fileState(String(destination));
      throw Object.assign(new Error('Destination exists'), { code: 'EEXIST' });
    });
    const result = await storage.save(url);
    expect(
      await fileState(outputPath(result.manifest.candidates[0]!.url)),
    ).toEqual(winner);
  });

  it('never falls back to copy or replacement when hard links are unavailable', async () => {
    vi.mocked(link).mockRejectedValueOnce(
      Object.assign(new Error('Unsupported filesystem'), { code: 'EXDEV' }),
    );
    await expect(storage.save(url)).rejects.toBeInstanceOf(ImageStorageError);
    expect(rename).not.toHaveBeenCalled();
    expect(await storage.readReady(url)).toBeNull();
  });

  it('does not steal an old lock based on age, and does not remove another owner lock', async () => {
    await mkdir(join(stateRoot, 'locks'));
    const lock = join(stateRoot, 'locks', `${id}.lock`);
    await writeFile(lock, 'unknown-owner', { flag: 'wx' });
    await utimes(lock, new Date(0), new Date(0));
    const before = await fileState(lock);
    await expect(storage.save(url)).rejects.toMatchObject({ code: 'BUSY' });
    expect(await fileState(lock)).toEqual(before);
  });

  it.each(['dimensions', 'hash', 'bytes', 'corrupt WebP'] as const)(
    'rejects forged encoder %s before exposing a file',
    async (kind) => {
      const result = cloneGenerated();
      const first = result.variants[0]!;
      if (kind === 'dimensions') {
        first.width--;
        first.height--;
      }
      if (kind === 'hash') first.sha256 = 'f'.repeat(64);
      if (kind === 'bytes') first.bytes++;
      if (kind === 'corrupt WebP') {
        first.buffer = Buffer.from('RIFFbrokenWEBPprivate-content');
        first.bytes = first.buffer.length;
        first.sha256 = hash(first.buffer);
      }
      await expect(storage.save(url, async () => result)).rejects.toMatchObject(
        { code: 'INVALID_VARIANT' },
      );
      expect(link).not.toHaveBeenCalled();
      expect(await storage.readReady(url)).toBeNull();
    },
  );

  it('detects source replacement during encoding and publishes no stale readiness', async () => {
    preserveOriginal = false;
    const replacement = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'red' },
    })
      .webp()
      .toBuffer();
    await expect(
      storage.save(url, async (buffer) => {
        await writeFile(originalPath, replacement);
        return generateImageVariants(buffer);
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(await readFile(originalPath)).toEqual(replacement);
    expect(link).not.toHaveBeenCalled();
    expect(await storage.readReady(url)).toBeNull();
  });

  it('keeps another owner lock and aborts publication when lock ownership changes', async () => {
    const lock = join(stateRoot, 'locks', `${id}.lock`);
    await expect(
      storage.save(url, async (buffer) => {
        await writeFile(lock, 'different owner');
        return generateImageVariants(buffer);
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(lock, 'utf8')).toBe('different owner');
    expect(link).not.toHaveBeenCalled();
    expect(await storage.readReady(url)).toBeNull();
  });

  it('detects source replacement during final variant verification before publishing readiness', async () => {
    preserveOriginal = false;
    const replacement = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'red' },
    })
      .webp()
      .toBuffer();
    const lastOutput = outputPath(imageVariantUrl(id, hash(source), 640));
    let manifestStaged = false;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (
        String(path).endsWith(sep + 'manifest.json') &&
        typeof flags === 'number' &&
        flags & constants.O_CREAT
      )
        manifestStaged = true;
      if (path === lastOutput && manifestStaged) {
        manifestStaged = false;
        await native.writeFile(originalPath, replacement);
      }
      return native.open(path, flags, mode);
    });
    await expect(storage.save(url)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    expect(await readFile(originalPath)).toEqual(replacement);
    expect(rename).not.toHaveBeenCalled();
    await expect(stat(readyPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await storage.readReady(url)).toBeNull();
  });

  it('rechecks final files after staging the manifest and does not announce a newly missing output', async () => {
    const missing = outputPath(imageVariantUrl(id, hash(source), 192));
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (
        String(path).endsWith(sep + 'manifest.json') &&
        typeof flags === 'number' &&
        flags & constants.O_CREAT
      )
        await native.unlink(missing);
      return native.open(path, flags, mode);
    });
    await expect(storage.save(url)).rejects.toMatchObject({
      code: 'INVALID_VARIANT',
    });
    await expect(stat(readyPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await storage.readReady(url)).toBeNull();
  });

  it('rebuilds a truncated manifest using verified existing variants', async () => {
    const first = await storage.save(url);
    const paths = first.manifest.candidates.map((candidate) =>
      outputPath(candidate.url),
    );
    const before = await Promise.all(paths.map(fileState));
    await writeFile(readyPath(), '{"source":');
    expect(await storage.readReady(url)).toBeNull();
    expect((await storage.save(url)).status).toBe('READY');
    expect(await Promise.all(paths.map(fileState))).toEqual(before);
  });

  it('rejects a misleading manifest with correct checksum but incorrect actual dimensions', async () => {
    const result = await storage.save(url);
    result.manifest.candidates[0]!.width--;
    result.manifest.candidates[0]!.height--;
    await writeFile(readyPath(), JSON.stringify(result.manifest));
    expect(await storage.readReady(url)).toBeNull();
  });

  it('checks original size before reading or calling the encoder', async () => {
    await writeFile(originalPath, Buffer.alloc(5 * 1024 * 1024 + 1));
    originalState = await fileState(originalPath);
    const encode = vi.fn(generateImageVariants);
    await expect(storage.save(url, encode)).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
    expect(encode).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'linux')(
    'Linux: uses actual O_NOFOLLOW and fsync directories with private POSIX modes',
    async () => {
      const result = await storage.save(url);
      expect((await stat(stateRoot)).mode & 0o077).toBe(0);
      expect((await stat(readyPath())).mode & 0o077).toBe(0);
      expect(
        vi
          .mocked(open)
          .mock.calls.some(
            ([, flags]) =>
              typeof flags === 'number' &&
              (flags & constants.O_DIRECTORY) !== 0,
          ),
      ).toBe(true);
      expect(
        vi
          .mocked(open)
          .mock.calls.some(
            ([path, flags]) =>
              path === originalPath &&
              typeof flags === 'number' &&
              (flags & constants.O_NOFOLLOW) !== 0,
          ),
      ).toBe(true);
      for (const candidate of result.manifest.candidates)
        expect((await stat(outputPath(candidate.url))).mode & 0o077).toBe(0);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'Linux: refuses a source file symlink using real native symlinks',
    async () => {
      const target = join(outside, 'source.webp');
      await writeFile(target, source, { flag: 'wx' });
      await unlink(originalPath);
      await symlink(target, originalPath, 'file');
      const before = await fileState(target);
      await expect(storage.save(url)).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
      expect(await fileState(target)).toEqual(before);
      await unlink(originalPath);
      await writeFile(originalPath, source, { flag: 'wx' });
      originalState = await fileState(originalPath);
    },
  );
});
