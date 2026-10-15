import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  contains,
  imageRoot,
  ImageStorageError,
} from '../../src/product/image-storage.js';

export const MAX_SCOPE = 50;
export const runIdSchema = z
  .uuidv4()
  .refine((value) => value === value.toLowerCase());
export const optionsSchema = z.strictObject({
  apply: z.boolean(),
  manifest: z.string(),
  sourceRoot: z.string(),
  variantsRoot: z.string(),
  stateRoot: z.string(),
  limit: z.number().int().min(1).max(MAX_SCOPE).optional(),
  concurrency: z.union([z.literal(1), z.literal(2)]),
  resume: runIdSchema.optional(),
});
export type BackfillOptions = z.infer<typeof optionsSchema>;

export const help = [
  'Offline product image backfill; no database or network access.',
  'Required: --manifest PATH --source-root PATH --variants-root PATH --state-root PATH',
  '--dry-run (default): read-only inspection; no encode, logs, locks or directories.',
  '--apply: writes only inside one pre-created OS-temp/korzina-image-backfill-* sandbox.',
  '--limit N: unique URLs considered, including ready/failed/skipped; default 20, maximum 50.',
  '--concurrency N: 1 or 2; default 1. Widths encode sequentially in supervised children.',
  '--resume RUN_ID: reverify the frozen scope; inherit limit; a different explicit limit is rejected.',
  'Roots must be existing, absolute, disjoint, trusted directories without symlinks.',
  'Apply is refused with NODE_ENV=production. Unknown-owner locks are never stolen.',
].join('\n');

export function validateOptions(input: BackfillOptions): BackfillOptions {
  const options = optionsSchema.parse(input);
  options.sourceRoot = imageRoot(options.sourceRoot);
  options.variantsRoot = imageRoot(options.variantsRoot);
  options.stateRoot = imageRoot(options.stateRoot);
  options.manifest = imageRoot(options.manifest);
  const roots = [options.sourceRoot, options.variantsRoot, options.stateRoot];
  for (const [index, root] of roots.entries())
    for (const other of roots.slice(index + 1))
      if (contains(root, other) || contains(other, root))
        throw new ImageStorageError('INVALID_PATH');
  if (roots.some((root) => contains(root, options.manifest)))
    throw new ImageStorageError('INVALID_PATH');
  if (options.apply) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('Production mode is forbidden');
    const first = relative(imageRoot(tmpdir()), options.sourceRoot).split(
      sep,
    )[0]!;
    const sandbox = join(imageRoot(tmpdir()), first);
    if (
      !/^korzina-image-backfill-[A-Za-z0-9-]{6,80}$/.test(first) ||
      ![...roots, options.manifest].every(
        (path) => path !== sandbox && contains(sandbox, path),
      ) ||
      dirname(sandbox) !== imageRoot(tmpdir())
    )
      throw new Error('Apply requires one explicit OS temp test sandbox');
  }
  return options;
}

export function parseOptions(args: string[]): BackfillOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const names = new Set([
    '--manifest',
    '--source-root',
    '--variants-root',
    '--state-root',
    '--limit',
    '--concurrency',
    '--resume',
  ]);
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (flags.has(name) || values.has(name))
      throw new Error('Duplicate argument');
    if (name === '--apply' || name === '--dry-run') flags.add(name);
    else {
      if (
        !names.has(name) ||
        !args[index + 1] ||
        args[index + 1]!.startsWith('--')
      )
        throw new Error('Unknown or incomplete argument');
      values.set(name, args[++index]!);
    }
  }
  if (flags.size > 1) throw new Error('Choose one mode');
  const integer = (name: string, fallback?: number) => {
    const value = values.get(name);
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value))
      throw new Error('Expected a positive integer');
    return Number(value);
  };
  return validateOptions(
    optionsSchema.parse({
      apply: flags.has('--apply'),
      manifest: values.get('--manifest'),
      sourceRoot: values.get('--source-root'),
      variantsRoot: values.get('--variants-root'),
      stateRoot: values.get('--state-root'),
      limit: integer('--limit'),
      concurrency: integer('--concurrency', 1),
      resume: values.get('--resume'),
    }),
  );
}
