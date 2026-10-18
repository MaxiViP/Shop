import { z } from 'zod';
import { contains, imageRoot } from '../../src/product/image-storage.js';
import {
  batchSchema,
  runIdSchema,
  RunnerError,
  sha256Schema,
} from './model.js';

const schema = z.strictObject({
  apply: z.boolean().default(false),
  inventory: z.string(),
  sourceRoot: z.string(),
  variantsRoot: z.string(),
  stateRoot: z.string(),
  batchSize: batchSchema.default(1),
  approval: z.string().optional(),
  approvalSha256: sha256Schema.optional(),
  resume: runIdSchema.optional(),
});
export type Options = z.infer<typeof schema>;
export function validateOptions(value: unknown): Options {
  const options = schema.parse(value);
  for (const key of [
    'inventory',
    'sourceRoot',
    'variantsRoot',
    'stateRoot',
  ] as const)
    options[key] = imageRoot(options[key]);
  if (options.approval) options.approval = imageRoot(options.approval);
  const roots = [options.sourceRoot, options.variantsRoot, options.stateRoot];
  for (const [index, root] of roots.entries()) {
    if (
      roots
        .slice(index + 1)
        .some((other) => contains(root, other) || contains(other, root))
    )
      throw new RunnerError('INVALID_ROOT');
    if (
      [options.inventory, options.approval].some(
        (path) => path && contains(root, path),
      )
    )
      throw new RunnerError('INVALID_ROOT');
  }
  if (
    Boolean(options.approval) !== Boolean(options.approvalSha256) ||
    (options.resume && !options.approval)
  )
    throw new RunnerError('APPROVAL_REQUIRED');
  if (options.approval === options.inventory)
    throw new RunnerError('INVALID_ROOT');
  return options;
}
export function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const names = [
    '--inventory',
    '--source-root',
    '--variants-root',
    '--state-root',
    '--batch-size',
    '--approval',
    '--approval-sha256',
    '--resume',
  ];
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (values.has(name) || flags.has(name))
      throw new RunnerError('INVALID_OPTIONS');
    if (name === '--apply' || name === '--dry-run') flags.add(name);
    else {
      if (
        !names.includes(name) ||
        !args[index + 1] ||
        args[index + 1]!.startsWith('--')
      )
        throw new RunnerError('INVALID_OPTIONS');
      values.set(name, args[++index]!);
    }
  }
  if (flags.size > 1) throw new RunnerError('INVALID_OPTIONS');
  const batch = values.get('--batch-size');
  if (batch !== undefined && !/^(1|5|20|50)$/.test(batch))
    throw new RunnerError('INVALID_OPTIONS');
  return validateOptions({
    apply: flags.has('--apply'),
    inventory: values.get('--inventory'),
    sourceRoot: values.get('--source-root'),
    variantsRoot: values.get('--variants-root'),
    stateRoot: values.get('--state-root'),
    batchSize: batch === undefined ? 1 : Number(batch),
    approval: values.get('--approval'),
    approvalSha256: values.get('--approval-sha256'),
    resume: values.get('--resume'),
  });
}
