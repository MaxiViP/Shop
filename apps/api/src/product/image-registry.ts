import { Inject, Injectable } from '@nestjs/common';
import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { IMAGE_OPTIONS, type ImageRegistryOptions } from './image-config.js';
import {
  MAX_IMAGE_MANIFEST_BYTES,
  parseImageManifest,
  parseVariantUrl,
  productImageId,
  type ImageCandidate,
  type ImageManifest,
} from './image-manifest.js';
import {
  child,
  contains,
  directory,
  hasCode,
  imageRoot,
  readBounded,
  sameFile,
  sameSource,
  sourceVersion,
} from './image-storage.js';
import { webpDimensions } from './image-webp.js';

export interface ProductImageMetadata {
  width: number;
  height: number;
  variants: {
    version: 'v1';
    webp: { url: string; width: number; height: number }[];
  };
}
export interface ProductImage {
  url: string;
  alt: string | null;
  width?: number;
  height?: number;
  variants?: ProductImageMetadata['variants'];
}
interface Roots {
  sourceRoot: string;
  publicRoot: string;
  stateRoot: string;
}
interface Stamp {
  root: keyof Roots;
  parts: string[];
  max: number;
  signature: string | null;
}
interface Ready {
  manifest: ImageManifest;
  candidates: ImageCandidate[];
  stamps: Stamp[];
}
interface Cached {
  ready: Ready | null;
  expires: number;
  bytes: number;
}
const CONCURRENCY = 4;
const MAX_PENDING = 256;
const MAX_BATCH = 512;
const limit = (value: number | undefined, fallback: number) =>
  Number.isSafeInteger(value) && value! > 0
    ? Math.min(value!, fallback)
    : fallback;
const signature = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

@Injectable()
export class ImageRegistry {
  private readonly roots: Roots | null;
  private identities: BigIntStats[] | null = null;
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<Ready | null>>();
  private readonly waiters: (() => void)[] = [];
  private active = 0;
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly positiveTtl: number;
  private readonly negativeTtl: number;
  private readonly now: () => number;

  constructor(@Inject(IMAGE_OPTIONS) options: ImageRegistryOptions) {
    this.maxEntries = limit(options.cache?.maxEntries, 10_000);
    this.maxBytes = limit(options.cache?.maxBytes, 16 * 1024 * 1024);
    this.positiveTtl = limit(options.cache?.positiveTtlMs, 30_000);
    this.negativeTtl = limit(options.cache?.negativeTtlMs, 5_000);
    this.now = options.now ?? Date.now;
    try {
      if (!options.enabled) throw new Error('Disabled');
      const roots: Roots = {
        sourceRoot: imageRoot(options.sourceRoot!),
        publicRoot: imageRoot(options.publicRoot!),
        stateRoot: imageRoot(options.stateRoot!),
      };
      if (
        [roots.sourceRoot, roots.publicRoot].some(
          (root) =>
            contains(root, roots.stateRoot) || contains(roots.stateRoot, root),
        ) ||
        (roots.sourceRoot !== roots.publicRoot &&
          (contains(roots.sourceRoot, roots.publicRoot) ||
            contains(roots.publicRoot, roots.sourceRoot)))
      )
        throw new Error('Overlapping roots');
      this.roots = roots;
    } catch {
      // Disabled/invalid configuration never makes a catalogue unavailable.
      this.roots = null;
    }
  }

  get enabled() {
    return this.roots !== null;
  }

  private async bounded<T>(read: () => Promise<T>): Promise<T | null> {
    if (this.active >= CONCURRENCY) {
      if (this.waiters.length >= MAX_PENDING) return null;
      await new Promise<void>((done) => this.waiters.push(done));
    } else this.active++;
    try {
      return await read();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async checkRoots() {
    const roots = this.roots!;
    const identities: BigIntStats[] = [];
    for (const path of Object.values(roots))
      identities.push(await directory(path));
    const state = identities[2]!;
    if (
      process.platform === 'linux' &&
      ((state.mode & 0o077n) !== 0n || state.uid !== BigInt(process.getuid!()))
    )
      throw new Error('Unsafe private root');
    if (
      this.identities &&
      identities.some(
        (entry, index) => !sameFile(entry, this.identities![index]!),
      )
    )
      throw new Error('Root changed');
    this.identities ??= identities;
  }

  private async probe(stamp: Stamp) {
    const path = child(this.roots![stamp.root], stamp.parts);
    try {
      await directory(dirname(path));
      const stat = await lstat(path, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size < 1n ||
        stat.size > BigInt(stamp.max)
      )
        throw new Error('Unsafe file');
      return signature(stat);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private async current(ready: Ready) {
    await this.checkRoots();
    for (const stamp of ready.stamps)
      if ((await this.probe(stamp)) !== stamp.signature) return false;
    return true;
  }

  private async load(url: string): Promise<Ready | null> {
    await this.checkRoots();
    const id = productImageId(url);
    const root = this.roots!;
    const file = await readBounded(
      root.stateRoot,
      ['ready', id + '.json'],
      MAX_IMAGE_MANIFEST_BYTES,
    );
    if (!file) return null;
    const manifest = parseImageManifest(file.buffer);
    if (manifest.source.url !== url) return null;
    const source = await readBounded(
      root.sourceRoot,
      [id + '.webp'],
      5 * 1024 * 1024,
    );
    if (!source || !sameSource(sourceVersion(source), manifest.source))
      return null;
    const stamps: Stamp[] = [
      {
        root: 'stateRoot',
        parts: ['ready', id + '.json'],
        max: MAX_IMAGE_MANIFEST_BYTES,
        signature: signature(file.stat),
      },
      {
        root: 'sourceRoot',
        parts: [id + '.webp'],
        max: 5 * 1024 * 1024,
        signature: signature(source.stat),
      },
    ];
    const candidates: ImageCandidate[] = [];
    for (const candidate of manifest.candidates) {
      const stamp: Stamp = {
        root: 'publicRoot',
        parts: candidate.url.slice('/uploads/products/'.length).split('/'),
        max: 2 * 1024 * 1024,
        signature: null,
      };
      try {
        // A strict private publisher already fully decoded these exact hashes.
        const data = await readBounded(root.publicRoot, stamp.parts, stamp.max);
        stamp.signature = data ? signature(data.stat) : null;
        stamps.push(stamp);
        if (
          !data ||
          data.sha256 !== candidate.sha256 ||
          data.buffer.length !== candidate.bytes
        )
          continue;
        const dimensions = webpDimensions(data.buffer);
        if (
          dimensions?.width === candidate.width &&
          dimensions.height === candidate.height
        )
          candidates.push(candidate);
      } catch {
        // Unsafe paths or failed reads invalidate this lookup. Missing files and
        // checksum mismatches above only exclude the affected candidate.
        return null;
      }
    }
    if (!candidates.length) return null;
    const ready = { manifest, candidates, stamps };
    return (await this.current(ready)) ? ready : null;
  }

  private remember(url: string, ready: Ready | null) {
    const bytes =
      Buffer.byteLength(url) + Buffer.byteLength(JSON.stringify(ready)) + 128;
    const previous = this.cache.get(url);
    if (previous) {
      this.bytes -= previous.bytes;
      this.cache.delete(url);
    }
    if (bytes > this.maxBytes) return;
    while (
      this.cache.size >= this.maxEntries ||
      this.bytes + bytes > this.maxBytes
    ) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(url, {
      ready,
      bytes,
      expires: this.now() + (ready ? this.positiveTtl : this.negativeTtl),
    });
    this.bytes += bytes;
  }

  private async lookup(url: string): Promise<Ready | null> {
    if (!this.enabled || typeof url !== 'string' || url.length > 128)
      return null;
    try {
      productImageId(url);
    } catch {
      return null;
    }
    const pending = this.pending.get(url);
    if (pending) return pending;
    if (this.pending.size >= MAX_PENDING) return null;
    const read = this.bounded(async () => {
      const cached = this.cache.get(url);
      if (cached && cached.expires > this.now()) {
        if (!cached.ready || (await this.current(cached.ready))) {
          this.cache.delete(url);
          this.cache.set(url, cached);
          return cached.ready;
        }
      }
      const ready = await this.load(url);
      this.remember(url, ready);
      return ready;
    })
      .catch(() => {
        this.remember(url, null);
        return null;
      })
      .finally(() => this.pending.delete(url));
    this.pending.set(url, read);
    return read;
  }

  async metadata(url: string): Promise<ProductImageMetadata | null> {
    const ready = await this.lookup(url);
    if (!ready) return null;
    const widths = new Map<
      number,
      { url: string; width: number; height: number }
    >();
    for (const { url, width, height } of ready.candidates)
      widths.set(width, { url, width, height });
    return {
      width: ready.manifest.source.width,
      height: ready.manifest.source.height,
      variants: {
        version: 'v1',
        webp: [...widths.values()].sort((a, b) => a.width - b.width),
      },
    };
  }

  async enrich<T extends { images: ProductImage[] }>(
    products: T[],
  ): Promise<T[]> {
    if (!this.enabled) return products;
    try {
      const urls = new Set<string>();
      for (const product of products) {
        if (!Array.isArray(product.images)) continue;
        for (const image of product.images)
          if (urls.size < MAX_BATCH) urls.add(image.url);
      }
      const values = new Map(
        await Promise.all(
          [...urls].map(
            async (url) => [url, await this.metadata(url)] as const,
          ),
        ),
      );
      return products.map((product) =>
        !Array.isArray(product.images)
          ? product
          : {
              ...product,
              images: product.images.map((image) => {
                const metadata = values.get(image.url);
                return metadata
                  ? { ...image, ...structuredClone(metadata) }
                  : image;
              }),
            },
      );
    } catch {
      return products;
    }
  }

  async variant(url: string) {
    if (!this.enabled) return null;
    try {
      const parsed = parseVariantUrl(url);
      const sourceUrl = '/uploads/products/' + parsed.id + '.webp';
      const ready = await this.lookup(sourceUrl);
      const candidate = ready?.candidates.find((entry) => entry.url === url);
      if (!ready || !candidate) return null;
      return await this.bounded(async () => {
        if (!(await this.current(ready))) return null;
        const file = await readBounded(
          this.roots!.publicRoot,
          url.slice('/uploads/products/'.length).split('/'),
          2 * 1024 * 1024,
        );
        if (
          !file ||
          file.sha256 !== candidate.sha256 ||
          file.buffer.length !== candidate.bytes
        )
          return null;
        const dimensions = webpDimensions(file.buffer);
        if (
          dimensions?.width !== candidate.width ||
          dimensions.height !== candidate.height ||
          !(await this.current(ready))
        )
          return null;
        return file;
      });
    } catch {
      return null;
    }
  }

  async originalExists(id: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      productImageId('/uploads/products/' + id + '.webp');
      return (
        (await this.bounded(async () => {
          await this.checkRoots();
          return (
            (await this.probe({
              root: 'sourceRoot',
              parts: [id + '.webp'],
              max: Number.MAX_SAFE_INTEGER,
              signature: null,
            })) !== null
          );
        })) ?? false
      );
    } catch {
      return false;
    }
  }
}
