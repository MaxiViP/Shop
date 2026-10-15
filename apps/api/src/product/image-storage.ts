import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import sharp from 'sharp';
import {
  encodeImageManifest,
  imageVariantUrl,
  ImageManifestError,
  MAX_IMAGE_MANIFEST_BYTES,
  parseImageManifest,
  parseVariantUrl,
  productImageId,
  type ImageCandidate,
  type ImageManifest,
} from './image-manifest.js';
import {
  generateImageVariants,
  IMAGE_VARIANT_PROFILES,
  type ImageVariants,
} from './image-variants.js';

const messages = {
  INVALID_PATH: 'Unsafe product image storage path',
  INVALID_FILE: 'Invalid or oversized image storage file',
  INVALID_SOURCE: 'Invalid product image source',
  INVALID_VARIANT: 'Invalid product image variant',
  SOURCE_CHANGED: 'Product image source is missing or changed',
  BUSY: 'Product image has an existing writer lock',
  CONFLICT: 'Product image publication conflict',
  UNSUPPORTED_FS: 'Image storage requires one local filesystem with hard links',
  IO: 'Product image storage operation failed',
} as const;

export class ImageStorageError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'ImageStorageError';
  }
}

interface Snapshot {
  buffer: Buffer;
  sha256: string;
  stat: BigIntStats;
}
export interface ImageStorageOptions {
  publicRoot: string;
  stateRoot: string;
}
export interface ImageStorageResult {
  status: 'READY' | 'UNCHANGED';
  manifest: ImageManifest;
  conflicts: string[];
}
export type ImageEncoder = (source: Buffer) => Promise<ImageVariants>;

const hash = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');
const hasCode = (error: unknown, code: string) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino;
const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  sameFile(a.stat, b.stat) &&
  a.stat.size === b.stat.size &&
  a.stat.mtimeNs === b.stat.mtimeNs &&
  a.sha256 === b.sha256;
const contains = (root: string, path: string) => {
  const fromRoot = relative(root, path);
  return (
    !isAbsolute(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith('..' + sep)
  );
};

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ImageStorageError) throw error;
    throw new ImageStorageError('IO');
  }
}

async function optionalStat(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function syncDirectory(path: string) {
  // Node has no supported directory fsync/O_NOFOLLOW equivalent on Windows.
  // Do not fake it or silently ignore Linux fsync errors.
  if (process.platform === 'win32') return;
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function directory(
  path: string,
  create = false,
  mode = 0o700,
): Promise<BigIntStats> {
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    const parent = current;
    current = join(current, part);
    if (create && !(await optionalStat(current))) {
      try {
        await mkdir(current, { mode });
        await syncDirectory(parent);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
      }
    }
    const entry = await lstat(current, { bigint: true });
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new ImageStorageError('INVALID_PATH');
  }
  if (relative(path, await realpath(path)) !== '')
    throw new ImageStorageError('INVALID_PATH');
  return lstat(path, { bigint: true });
}

function child(root: string, parts: string[]) {
  const path = join(root, ...parts);
  if (path === root || !contains(root, path))
    throw new ImageStorageError('INVALID_PATH');
  return path;
}

async function readBounded(
  root: string,
  parts: string[],
  max: number,
): Promise<Snapshot | null> {
  const path = child(root, parts);
  try {
    await directory(dirname(path));
    const before = await optionalStat(path);
    if (!before) return null;
    if (before.isSymbolicLink() || !before.isFile())
      throw new ImageStorageError('INVALID_PATH');
    if (before.size < 1 || before.size > BigInt(max))
      throw new ImageStorageError('INVALID_FILE');
    const flags =
      constants.O_RDONLY |
      (process.platform === 'win32'
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handle = await open(path, flags);
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        !sameFile(before, opened) ||
        before.size !== opened.size ||
        before.mtimeNs !== opened.mtimeNs
      )
        throw new ImageStorageError('INVALID_PATH');
      // Bounded even if another process grows the file between stat and read.
      const data = Buffer.alloc(Number(opened.size) + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const entry = await lstat(path, { bigint: true });
      if (
        entry.isSymbolicLink() ||
        !sameFile(entry, opened) ||
        !sameFile(after, opened) ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        offset !== Number(opened.size)
      )
        throw new ImageStorageError('INVALID_FILE');
      const buffer = data.subarray(0, offset);
      return { buffer, sha256: hash(buffer), stat: after };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

async function writePrivate(path: string, data: Buffer) {
  await directory(dirname(path));
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function validWebp(
  file: Snapshot,
  candidate: ImageCandidate,
): Promise<boolean> {
  if (
    file.buffer.length !== candidate.bytes ||
    file.sha256 !== candidate.sha256
  )
    return false;
  try {
    const image = sharp(file.buffer, {
      limitInputPixels: 640 * 640,
      limitInputChannels: 4,
      failOn: 'warning',
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== 'webp' ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.loop !== undefined ||
      metadata.delay !== undefined ||
      metadata.width !== candidate.width ||
      metadata.height !== candidate.height ||
      metadata.orientation !== undefined ||
      metadata.hasProfile ||
      metadata.exif ||
      metadata.xmp
    )
      return false;
    await image.stats();
    return true;
  } catch {
    return false;
  }
}

function idFrom(url: string) {
  try {
    return productImageId(url);
  } catch {
    throw new ImageStorageError('INVALID_PATH');
  }
}

/**
 * Standalone storage, with explicit, pre-provisioned roots and no API wiring.
 * Roots/ancestors must have trusted owners and no untrusted concurrent writers.
 * lstat/realpath + fd identity checks are not an openat-style sandbox against
 * a hostile process swapping parent directories (especially on Windows).
 */
export class ImageStorage {
  private constructor(
    private readonly roots: ImageStorageOptions,
    private readonly publicIdentity: BigIntStats,
    private readonly stateIdentity: BigIntStats,
  ) {}

  static async open(options: ImageStorageOptions): Promise<ImageStorage> {
    return guarded(async () => {
      if (!['linux', 'win32'].includes(process.platform))
        throw new ImageStorageError('UNSUPPORTED_FS');
      for (const path of [options.publicRoot, options.stateRoot])
        if (
          typeof path !== 'string' ||
          !isAbsolute(path) ||
          path.includes('\0') ||
          path.split(/[\\/]/).some((part) => part === '..' || part === '.') ||
          resolve(path) === parse(path).root ||
          (process.platform === 'win32' &&
            (!/^[A-Za-z]:[\\/]/.test(path) ||
              /[:<>"|?*]/.test(path.slice(3)) ||
              path.split(/[\\/]/).some((part) => /[. ]$/.test(part))))
        )
          throw new ImageStorageError('INVALID_PATH');
      const roots = {
        publicRoot: resolve(options.publicRoot),
        stateRoot: resolve(options.stateRoot),
      };
      if (
        contains(roots.publicRoot, roots.stateRoot) ||
        contains(roots.stateRoot, roots.publicRoot)
      )
        throw new ImageStorageError('INVALID_PATH');
      const publicIdentity = await directory(roots.publicRoot);
      const stateIdentity = await directory(roots.stateRoot);
      if (publicIdentity.dev !== stateIdentity.dev)
        throw new ImageStorageError('UNSUPPORTED_FS');
      // POSIX privacy is enforceable here. Windows requires provisioned ACLs.
      if (
        process.platform === 'linux' &&
        ((stateIdentity.mode & 0o077n) !== 0n ||
          stateIdentity.uid !== BigInt(process.getuid!()))
      )
        throw new ImageStorageError('INVALID_PATH');
      return new ImageStorage(roots, publicIdentity, stateIdentity);
    });
  }

  private async checkRoots() {
    const state = await directory(this.roots.stateRoot);
    if (
      !sameFile(await directory(this.roots.publicRoot), this.publicIdentity) ||
      !sameFile(state, this.stateIdentity) ||
      (process.platform === 'linux' &&
        ((state.mode & 0o077n) !== 0n || state.uid !== this.stateIdentity.uid))
    )
      throw new ImageStorageError('INVALID_PATH');
  }

  private async ensure(root: string, parts: string[]) {
    await this.checkRoots();
    const path = child(root, parts);
    const entry = await directory(
      path,
      true,
      root === this.roots.stateRoot ? 0o700 : 0o755,
    );
    if (entry.dev !== this.publicIdentity.dev)
      throw new ImageStorageError('UNSUPPORTED_FS');
    return path;
  }

  private async source(url: string) {
    const id = idFrom(url);
    const file = await readBounded(
      this.roots.publicRoot,
      [`${id}.webp`],
      5 * 1024 * 1024,
    );
    if (!file) throw new ImageStorageError('SOURCE_CHANGED');
    try {
      const image = sharp(file.buffer, {
        limitInputPixels: 25_000_000,
        limitInputChannels: 4,
        failOn: 'warning',
      });
      const metadata = await image.metadata();
      if (
        metadata.format !== 'webp' ||
        (metadata.pages ?? 1) !== 1 ||
        metadata.loop !== undefined ||
        metadata.delay !== undefined ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > 16384 ||
        metadata.height > 16384
      )
        throw new ImageStorageError('INVALID_SOURCE');
      await image.stats();
      const source: ImageManifest['source'] = {
        url,
        format: 'webp',
        ...metadata.autoOrient,
        bytes: file.buffer.length,
        sha256: file.sha256,
        fingerprint: {
          mtimeNs: file.stat.mtimeNs.toString(),
          dev: file.stat.dev.toString(),
          ino: file.stat.ino.toString(),
        },
      };
      return { file, source };
    } catch {
      throw new ImageStorageError('INVALID_SOURCE');
    }
  }

  private async checkSource(url: string, expected: Snapshot) {
    await this.checkRoots();
    let actual: Snapshot | null;
    try {
      actual = await readBounded(
        this.roots.publicRoot,
        [`${idFrom(url)}.webp`],
        5 * 1024 * 1024,
      );
    } catch (error) {
      if (error instanceof ImageStorageError && error.code === 'INVALID_FILE')
        throw new ImageStorageError('SOURCE_CHANGED');
      throw error;
    }
    if (!actual || !sameSnapshot(expected, actual))
      throw new ImageStorageError('SOURCE_CHANGED');
  }

  private variantParts(url: string) {
    parseVariantUrl(url);
    return url.slice('/uploads/products/'.length).split('/');
  }

  private async verified(candidate: ImageCandidate): Promise<boolean> {
    const parts = this.variantParts(candidate.url);
    let file: Snapshot | null;
    try {
      file = await readBounded(this.roots.publicRoot, parts, 2 * 1024 * 1024);
    } catch (error) {
      if (error instanceof ImageStorageError && error.code === 'INVALID_FILE')
        return false;
      throw error;
    }
    return file !== null && (await validWebp(file, candidate));
  }

  private async ready(
    url: string,
    source: ImageManifest['source'],
  ): Promise<ImageManifest | null> {
    let manifest: ImageManifest;
    try {
      const file = await readBounded(
        this.roots.stateRoot,
        ['ready', `${idFrom(url)}.json`],
        MAX_IMAGE_MANIFEST_BYTES,
      );
      if (!file) return null;
      manifest = parseImageManifest(file.buffer);
    } catch (error) {
      if (
        error instanceof ImageManifestError ||
        (error instanceof ImageStorageError && error.code === 'INVALID_FILE')
      )
        return null;
      throw error;
    }
    if (JSON.stringify(manifest.source) !== JSON.stringify(source)) return null;
    for (const candidate of manifest.candidates)
      if (!(await this.verified(candidate))) return null;
    return manifest;
  }

  async readReady(url: string): Promise<ImageManifest | null> {
    return guarded(async () => {
      idFrom(url);
      await this.checkRoots();
      let current: Awaited<ReturnType<ImageStorage['source']>>;
      try {
        current = await this.source(url);
      } catch (error) {
        if (
          error instanceof ImageStorageError &&
          ['SOURCE_CHANGED', 'INVALID_SOURCE', 'INVALID_FILE'].includes(
            error.code,
          )
        )
          return null;
        throw error;
      }
      const manifest = await this.ready(url, current.source);
      if (manifest) {
        try {
          await this.checkSource(url, current.file);
        } catch (error) {
          if (
            error instanceof ImageStorageError &&
            error.code === 'SOURCE_CHANGED'
          )
            return null;
          throw error;
        }
      }
      return manifest;
    });
  }

  private async publish(
    candidate: ImageCandidate,
    buffer: Buffer,
    work: string,
    conflicts: string[],
  ) {
    if (await this.verified(candidate)) return candidate;
    const original = child(
      this.roots.publicRoot,
      this.variantParts(candidate.url),
    );
    if (await optionalStat(original)) {
      conflicts.push(candidate.url);
      const path = parseVariantUrl(candidate.url);
      candidate = {
        ...candidate,
        url: imageVariantUrl(
          path.id,
          path.sourceHash,
          path.size,
          candidate.sha256,
        ),
      };
      if (await this.verified(candidate)) return candidate;
    }
    const parts = this.variantParts(candidate.url);
    const destination = child(this.roots.publicRoot, parts);
    await this.ensure(this.roots.publicRoot, parts.slice(0, -1));
    const temp = join(work, basename(destination));
    await writePrivate(temp, buffer);
    // Verify the actual staged file, not only the encoder's in-memory report.
    const staged = await readBounded(
      this.roots.stateRoot,
      relative(this.roots.stateRoot, temp).split(sep),
      2 * 1024 * 1024,
    );
    if (!staged || !(await validWebp(staged, candidate)))
      throw new ImageStorageError('INVALID_VARIANT');
    await this.checkRoots();
    await directory(dirname(destination));
    try {
      await link(temp, destination);
    } catch (error) {
      if (
        ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].some((code) =>
          hasCode(error, code),
        )
      )
        throw new ImageStorageError('UNSUPPORTED_FS');
      if (!hasCode(error, 'EEXIST')) throw error;
      if (!(await this.verified(candidate)))
        throw new ImageStorageError('CONFLICT');
    }
    await syncDirectory(dirname(destination));
    if (!(await this.verified(candidate)))
      throw new ImageStorageError('INVALID_VARIANT');
    await unlink(temp);
    await syncDirectory(work);
    return candidate;
  }

  private async checkLock(
    path: string,
    identity: BigIntStats,
    ownerHash?: string,
  ) {
    await this.checkRoots();
    await directory(dirname(path));
    const actual = await optionalStat(path);
    if (!actual || actual.isSymbolicLink() || !sameFile(actual, identity))
      throw new ImageStorageError('CONFLICT');
    if (ownerHash !== undefined) {
      const file = await readBounded(
        this.roots.stateRoot,
        ['locks', basename(path)],
        1024,
      );
      if (!file || file.sha256 !== ownerHash)
        throw new ImageStorageError('CONFLICT');
    }
  }

  private async releaseLock(
    path: string,
    identity: BigIntStats,
    ownerHash?: string,
  ) {
    await this.checkLock(path, identity, ownerHash);
    await unlink(path);
    await syncDirectory(dirname(path));
  }

  private async acquireLock(id: string) {
    await this.ensure(this.roots.stateRoot, ['locks']);
    const path = child(this.roots.stateRoot, ['locks', `${id}.lock`]);
    const existing = await optionalStat(path);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
      throw new ImageStorageError('INVALID_PATH');
    const handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    ).catch((error: unknown) => {
      if (hasCode(error, 'EEXIST')) throw new ImageStorageError('BUSY');
      throw error;
    });
    let identity: BigIntStats | undefined;
    let complete = false;
    const data = Buffer.from(
      JSON.stringify({
        owner: randomUUID(),
        pid: process.pid,
        host: hostname(),
      }),
    );
    try {
      identity = await handle.stat({ bigint: true });
      await handle.writeFile(data);
      await handle.sync();
      await syncDirectory(dirname(path));
      complete = true;
      return { path, identity, sha256: hash(data) };
    } finally {
      try {
        if (!complete && identity) await this.releaseLock(path, identity);
      } finally {
        await handle.close();
      }
    }
  }

  async save(
    url: string,
    encode: ImageEncoder = generateImageVariants,
  ): Promise<ImageStorageResult> {
    return guarded(async () => {
      const id = idFrom(url);
      await this.checkRoots();
      const lock = await this.acquireLock(id);
      try {
        const current = await this.source(url);
        const ready = await this.ready(url, current.source);
        if (ready) {
          await this.checkSource(url, current.file);
          return { status: 'UNCHANGED', manifest: ready, conflicts: [] };
        }
        const result = await encode(Buffer.from(current.file.buffer));
        if (
          result.profile !== 'v1' ||
          result.source.format !== current.source.format ||
          result.source.width !== current.source.width ||
          result.source.height !== current.source.height ||
          result.source.bytes !== current.source.bytes ||
          result.source.sha256 !== current.source.sha256 ||
          !Array.isArray(result.variants) ||
          !result.variants.length ||
          result.variants.length > 3
        )
          throw new ImageStorageError('INVALID_VARIANT');
        const buffers = result.variants.map((variant) => {
          if (
            !Buffer.isBuffer(variant.buffer) ||
            variant.buffer.length > 2 * 1024 * 1024
          )
            throw new ImageStorageError('INVALID_VARIANT');
          return Buffer.from(variant.buffer);
        });
        let manifest: ImageManifest;
        try {
          manifest = parseImageManifest(
            encodeImageManifest({
              schemaVersion: 1,
              profile: { version: 'v1', ...IMAGE_VARIANT_PROFILES.v1 },
              source: current.source,
              candidates: result.variants.map((variant) => ({
                url: imageVariantUrl(
                  id,
                  current.source.sha256,
                  variant.sizes[0]!,
                ),
                sizes: variant.sizes,
                width: variant.width,
                height: variant.height,
                bytes: variant.bytes,
                sha256: variant.sha256,
              })),
            }),
          );
        } catch {
          throw new ImageStorageError('INVALID_VARIANT');
        }
        for (const [index, candidate] of manifest.candidates.entries())
          if (
            buffers[index]!.length !== candidate.bytes ||
            hash(buffers[index]!) !== candidate.sha256
          )
            throw new ImageStorageError('INVALID_VARIANT');
        const work = await this.ensure(this.roots.stateRoot, [
          'work',
          id,
          randomUUID(),
        ]);
        await this.checkSource(url, current.file);
        const conflicts: string[] = [];
        for (const [index, candidate] of manifest.candidates.entries()) {
          await this.checkLock(lock.path, lock.identity, lock.sha256);
          manifest.candidates[index] = await this.publish(
            candidate,
            buffers[index]!,
            work,
            conflicts,
          );
        }
        for (const candidate of manifest.candidates)
          if (!(await this.verified(candidate)))
            throw new ImageStorageError('INVALID_VARIANT');
        const tempManifest = join(work, 'manifest.json');
        const manifestData = encodeImageManifest(manifest);
        await writePrivate(tempManifest, manifestData);
        const stagedManifest = await readBounded(
          this.roots.stateRoot,
          relative(this.roots.stateRoot, tempManifest).split(sep),
          MAX_IMAGE_MANIFEST_BYTES,
        );
        if (!stagedManifest || stagedManifest.sha256 !== hash(manifestData))
          throw new ImageStorageError('INVALID_FILE');
        await this.ensure(this.roots.stateRoot, ['ready']);
        const finalManifest = child(this.roots.stateRoot, [
          'ready',
          `${id}.json`,
        ]);
        const old = await optionalStat(finalManifest);
        if (old?.isSymbolicLink() || (old && !old.isFile()))
          throw new ImageStorageError('INVALID_PATH');
        for (const candidate of manifest.candidates)
          if (!(await this.verified(candidate)))
            throw new ImageStorageError('INVALID_VARIANT');
        await this.checkSource(url, current.file);
        await this.checkLock(lock.path, lock.identity, lock.sha256);
        // Replacement is intentional ONLY for private metadata, under the lock.
        // Never unlink the previous ready file as a Windows rename fallback.
        await rename(tempManifest, finalManifest);
        await syncDirectory(dirname(finalManifest));
        await rmdir(work);
        await syncDirectory(dirname(work));
        return { status: 'READY', manifest, conflicts };
      } finally {
        await this.releaseLock(lock.path, lock.identity, lock.sha256);
      }
    });
  }
}
