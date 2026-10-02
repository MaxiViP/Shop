import { BadRequestException, GoneException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, statfs, unlink, readdir, lstat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import sharp from 'sharp';
import { productUploadRoot } from '../common/image.js';

export const MAX_CHAT_RAW = 20 * 1024 * 1024;
export const MAX_CHAT_PIXELS = 60_000_000;
const MIN_FREE = 10n * 1024n * 1024n * 1024n;
const ORPHAN_GRACE = 24 * 60 * 60 * 1000;
const logger = new Logger('ChatImages');
const formats: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

export interface ChatUploadFile {
  path: string;
  filename: string;
  mimetype: string;
  size: number;
}

export function chatUploadRoot() {
  const production = '/var/lib/korzinamarket/uploads/chat';
  const directory = resolve(process.env.CHAT_UPLOAD_DIR ||
    (process.env.NODE_ENV === 'production' ? production : 'uploads/chat'));
  if (process.env.NODE_ENV === 'production' && directory !== production)
    throw new Error('Production chat storage must use /var/lib/korzinamarket/uploads/chat');
  const fromProducts = relative(productUploadRoot, directory);
  if (!fromProducts || (fromProducts !== '..' && !fromProducts.startsWith('..' + sep) && !isAbsolute(fromProducts)))
    throw new Error('Chat storage must be outside public product uploads');
  return directory;
}

export const chatIncomingRoot = () => join(chatUploadRoot(), '.incoming');

export function assertChatFreeBytes(free: bigint) {
  if (free >= MIN_FREE) return;
  logger.warn('Chat image upload rejected: fewer than 10 GiB free on the chat filesystem');
  throw new HttpException('Недостаточно места для загрузки фото. Попробуйте позже.', 507);
}

export async function checkChatSpace() {
  const disk = await statfs(chatUploadRoot(), { bigint: true });
  assertChatFreeBytes(disk.bavail * disk.bsize);
}

// Multer streams the bounded upload to a private staging directory and
// supplies a random 128-bit filename.
export function chatTempDestination(
  _request: unknown, _file: unknown,
  callback: (error: Error | null, destination?: string) => void,
) {
  void (async () => {
    await mkdir(chatIncomingRoot(), { recursive: true, mode: 0o750 });
    await checkChatSpace();
    callback(null, chatIncomingRoot());
  })().catch((error: unknown) => callback(error instanceof Error ? error : new Error('Chat storage unavailable')));
}

function pathFor(key: string, variant: 'full' | 'thumb') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key))
    throw new NotFoundException('Фото не найдено');
  return join(chatUploadRoot(), key + '.' + variant + '.webp');
}

function tempPath(file: ChatUploadFile) {
  if (!/^[0-9a-f]{32}$/.test(file.filename) || basename(file.path) !== file.filename ||
      resolve(file.path) !== join(chatIncomingRoot(), file.filename))
    throw new BadRequestException('Недопустимый файл загрузки');
  return file.path;
}

async function removeIfPresent(file: string) {
  try { await unlink(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function oldRegularFiles(directory: string, pattern: RegExp, now: Date) {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const result: string[] = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const info = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isFile() && now.getTime() - info.mtimeMs >= ORPHAN_GRACE)
      result.push(name);
  }
  return result;
}

@Injectable()
export class ChatImagesService {
  async save(file?: ChatUploadFile) {
    if (!file) throw new BadRequestException('Выберите фото');
    const source = tempPath(file);
    if (file.size > MAX_CHAT_RAW) throw new BadRequestException('Максимальный размер фото — 20 МБ');
    if (file.mimetype === 'image/heic' || file.mimetype === 'image/heif')
      throw new BadRequestException('HEIC/HEIF пока не поддерживаются. Выберите JPEG, PNG или WebP.');
    if (!Object.values(formats).includes(file.mimetype))
      throw new BadRequestException('Разрешены только JPEG, PNG и WebP');
    const handle = await open(source, 'r');
    let header: Buffer;
    try {
      header = Buffer.alloc(16);
      await handle.read(header, 0, header.length, 0);
      const diskSize = (await handle.stat()).size;
      if (diskSize !== file.size || diskSize > MAX_CHAT_RAW)
        throw new BadRequestException('Максимальный размер фото — 20 МБ');
    } finally { await handle.close(); }
    const magic = file.mimetype === 'image/jpeg'
      ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
      : file.mimetype === 'image/png'
        ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
    if (!magic) throw new BadRequestException('Содержимое файла не соответствует типу фото');
    try {
      const metadata = await sharp(source, { limitInputPixels: MAX_CHAT_PIXELS, failOn: 'warning' }).metadata();
      if (!metadata.format || formats[metadata.format] !== file.mimetype ||
          !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_CHAT_PIXELS ||
          (metadata.pages ?? 1) !== 1)
        throw new Error('unsupported image dimensions or format');
    } catch {
      throw new BadRequestException('Некорректное фото или размер более 60 мегапикселей');
    }
    await checkChatSpace();
    const key = randomUUID();
    try {
      // Both variants derive from the original decode. Sharp removes metadata
      // by default; rotate applies EXIF orientation before WebP encoding.
      const image = sharp(source, { limitInputPixels: MAX_CHAT_PIXELS, failOn: 'warning' }).rotate().toColourspace('srgb');
      const variants = await Promise.allSettled([
        image.clone().resize(4096, 4096, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 }).toFile(pathFor(key, 'full')),
        image.clone().resize(960, 960, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 }).toFile(pathFor(key, 'thumb')),
      ]);
      if (variants.some(result => result.status === 'rejected'))
        throw new Error('image conversion failed');
      return key;
    } catch {
      await this.remove(key);
      throw new BadRequestException('Не удалось обработать фото');
    }
  }

  async read(key: string, variant: 'full' | 'thumb') {
    try { return await readFile(pathFor(key, variant)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new GoneException('Фото больше не хранится');
      throw error;
    }
  }

  async remove(key: string) {
    await removeIfPresent(pathFor(key, 'full'));
    await removeIfPresent(pathFor(key, 'thumb'));
  }

  async removeTemp(file?: ChatUploadFile) {
    if (!file) return;
    const source = tempPath(file);
    const delays = [0, 30, 75, 150, 300, 600];
    for (const [attempt, delay] of delays.entries()) {
      if (delay) await wait(delay);
      try { await unlink(source); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(code ?? '') || attempt === delays.length - 1)
          throw error;
      }
    }
  }

  async sweepOrphans(now: Date, isReferenced: (key: string) => Promise<boolean>) {
    let count = 0;
    const root = chatUploadRoot();
    const names = await oldRegularFiles(root,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(full|thumb)\.webp$/, now);
    for (const name of names) {
      if (await isReferenced(name.slice(0, 36))) continue;
      await removeIfPresent(join(root, name));
      count++;
    }
    for (const name of await oldRegularFiles(chatIncomingRoot(), /^[0-9a-f]{32}$/, now)) {
      try {
        await this.removeTemp({ path: join(chatIncomingRoot(), name), filename: name, mimetype: '', size: 0 });
        count++;
      } catch (error) {
        logger.error(`Could not remove orphaned staged chat image ${name}`, error);
      }
    }
    return count;
  }
}
