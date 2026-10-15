import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  directory,
  hasCode,
  hash,
  ImageStorageError,
  readBounded,
  sameFile,
  syncDirectory,
  writePrivate,
} from '../../src/product/image-storage.js';

const readFlags =
  constants.O_RDONLY |
  (process.platform === 'win32'
    ? 0
    : constants.O_NOFOLLOW | constants.O_NONBLOCK);
const writeFlags =
  constants.O_RDWR |
  (process.platform === 'win32'
    ? 0
    : constants.O_NOFOLLOW | constants.O_NONBLOCK);

function unchanged(before: BigIntStats, after: BigIntStats) {
  return (
    sameFile(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs
  );
}

async function regular(path: string, max: number, writable = false) {
  await directory(dirname(path));
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (writable && before.nlink !== 1n)
  )
    throw new ImageStorageError('INVALID_PATH');
  if (before.size > BigInt(max)) throw new ImageStorageError('INVALID_FILE');
  const handle = await open(path, writable ? writeFlags : readFlags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !unchanged(before, opened) ||
      !opened.isFile() ||
      (writable && opened.nlink !== 1n)
    )
      throw new ImageStorageError('INVALID_PATH');
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Streaming input is capped both per file and per line. No recursive directory scan.
export async function jsonLines(
  path: string,
  max: number,
  lineMax: number,
  consume: (
    value: unknown,
    frame: { bytes: number; sha256: string; records: number },
  ) => Promise<void>,
  tornTail = false,
) {
  const { handle, before } = await regular(path, max);
  const digest = createHash('sha256');
  const completeDigest = createHash('sha256');
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let completeBytes = 0;
  let records = 0;
  try {
    const chunk = Buffer.alloc(16 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, max + 1 - bytes),
        bytes,
      );
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > max || BigInt(bytes) > before.size)
        throw new ImageStorageError('INVALID_FILE');
      const data = chunk.subarray(0, bytesRead);
      digest.update(data);
      pending = Buffer.concat([pending, data]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        if (end > lineMax) throw new ImageStorageError('INVALID_FILE');
        const raw = pending.subarray(0, end + 1);
        const line = raw.subarray(0, raw.length - 1);
        if (!line.length) throw new ImageStorageError('INVALID_FILE');
        const value: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(line),
        );
        completeDigest.update(raw);
        completeBytes += raw.length;
        records++;
        await consume(value, {
          bytes: completeBytes,
          sha256: completeDigest.copy().digest('hex'),
          records,
        });
        pending = pending.subarray(end + 1);
      }
      if (pending.length > lineMax) throw new ImageStorageError('INVALID_FILE');
    }
    if (pending.length && !tornTail)
      throw new ImageStorageError('INVALID_FILE');
    const after = await handle.stat({ bigint: true });
    const entry = await lstat(path, { bigint: true });
    if (
      entry.isSymbolicLink() ||
      !unchanged(before, after) ||
      !unchanged(before, entry) ||
      BigInt(bytes) !== before.size
    )
      throw new ImageStorageError('INVALID_FILE');
    return {
      bytes,
      sha256: digest.digest('hex'),
      completeBytes,
      completeHash: completeDigest.digest('hex'),
      records,
    };
  } finally {
    await handle.close();
  }
}

export async function readJson(path: string, max: number): Promise<unknown> {
  const file = await readBounded(dirname(path), [basename(path)], max);
  if (!file) throw new ImageStorageError('INVALID_FILE');
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(file.buffer),
  );
}

export async function replaceJson(path: string, value: unknown) {
  await directory(dirname(path));
  try {
    const old = await lstat(path);
    if (old.isSymbolicLink() || !old.isFile() || old.nlink !== 1)
      throw new ImageStorageError('INVALID_PATH');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const temp = join(dirname(path), randomUUID() + '.json');
  await writePrivate(temp, Buffer.from(JSON.stringify(value) + '\n'));
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

export async function runLock(path: string) {
  const data = Buffer.from(
    JSON.stringify({ token: randomUUID(), pid: process.pid }),
  );
  try {
    await writePrivate(path, data);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) throw new ImageStorageError('BUSY');
    throw error;
  }
  const identity = await lstat(path, { bigint: true });
  const check = async () => {
    const actual = await readBounded(dirname(path), [basename(path)], 1024);
    if (
      !actual ||
      !sameFile(identity, actual.stat) ||
      actual.sha256 !== hash(data)
    )
      throw new ImageStorageError('CONFLICT');
  };
  return Object.assign(
    async () => {
      await check();
      await unlink(path);
      await syncDirectory(dirname(path));
    },
    { check },
  );
}

// Metadata only: checked single-link file, owned run lock held by the caller.
export async function journalWriter(
  path: string,
  completeBytes: number,
  expectedHash: string,
) {
  const { handle, before } = await regular(path, 64 * 1024 * 1024, true);
  let offset = completeBytes;
  try {
    if (completeBytes > Number(before.size))
      throw new ImageStorageError('INVALID_FILE');
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(16 * 1024);
    for (let position = 0; position < completeBytes;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, completeBytes - position),
        position,
      );
      if (!bytesRead) throw new ImageStorageError('INVALID_FILE');
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (digest.copy().digest('hex') !== expectedHash)
      throw new ImageStorageError('CONFLICT');
    // Only the validated incomplete final line can be discarded.
    await handle.truncate(completeBytes);
    await handle.sync();
    return {
      async append(value: unknown) {
        const line = Buffer.from(JSON.stringify(value) + '\n');
        if (line.length > 24 * 1024 || offset + line.length > 64 * 1024 * 1024)
          throw new ImageStorageError('INVALID_FILE');
        const entry = await lstat(path, { bigint: true });
        if (
          entry.isSymbolicLink() ||
          !sameFile(entry, before) ||
          entry.nlink !== 1n ||
          entry.size !== BigInt(offset)
        )
          throw new ImageStorageError('CONFLICT');
        let written = 0;
        while (written < line.length) {
          const { bytesWritten } = await handle.write(
            line,
            written,
            line.length - written,
            offset + written,
          );
          if (!bytesWritten) throw new ImageStorageError('IO');
          written += bytesWritten;
        }
        await handle.sync();
        offset += line.length;
        digest.update(line);
        return { bytes: offset, sha256: digest.copy().digest('hex') };
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
