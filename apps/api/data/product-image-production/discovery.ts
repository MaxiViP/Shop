import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { productImageId } from '../../src/product/image-manifest.js';
import { directory } from '../../src/product/image-storage.js';
import { RunnerError } from './model.js';

// Telegram is a separate, opaque media namespace. Never traverse or encode it.
// The privileged supervisor additionally checks ACLs and mount topology.
export async function sourceNames(root: string): Promise<string[]> {
  const parent = await directory(root);
  const names: string[] = [];
  let count = 0;
  for await (const file of await opendir(root)) {
    if (++count > 100_000) throw new RunnerError('SOURCE_SCAN_LIMIT');
    const path = join(root, file.name);
    const info = await lstat(path, { bigint: true });
    if (file.name === 'telegram') {
      if (!info.isDirectory() || info.dev !== parent.dev ||
          await realpath(path) !== path || info.uid !== 0n || info.gid !== 0n ||
          (info.mode & 0o7777n) !== 0o755n)
        throw new RunnerError('TELEGRAM_ROOT_UNSAFE');
      continue;
    }
    productImageId('/uploads/products/' + file.name);
    if (!info.isFile() || info.nlink !== 1n || info.dev !== parent.dev)
      throw new RunnerError('SOURCE_ALIAS_UNVERIFIED');
    names.push(file.name);
  }
  return names.sort();
}
