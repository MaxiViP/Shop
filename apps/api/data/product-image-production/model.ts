import { z } from 'zod';
import {
  imageManifestSchema,
  productImageId,
} from '../../src/product/image-manifest.js';

export const MAX_INVENTORY = 32 * 1024 * 1024;
export const MAX_SCOPE = 256 * 1024;
export const MAX_JOURNAL = 64 * 1024 * 1024;
export const MAX_ATTEMPTS = 10;
export const sha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
export const runIdSchema = z
  .uuidv4()
  .refine((value) => value === value.toLowerCase());
export const batchSchema = z.union([
  z.literal(1),
  z.literal(5),
  z.literal(20),
  z.literal(50),
]);
export const versionSchema = imageManifestSchema.shape.source.pick({
  sha256: true,
  bytes: true,
  fingerprint: true,
});
export const entrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  url: z
    .string()
    .max(100)
    .refine((url) => {
      try {
        productImageId(url);
        return true;
      } catch {
        return false;
      }
    }),
  source: versionSchema,
});
export type Entry = z.infer<typeof entrySchema>;
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(30);
const rootSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  dev: uint,
  ino: uint,
});
export const rootsSchema = z.strictObject({
  sourceRoot: rootSchema,
  variantsRoot: rootSchema,
  stateRoot: rootSchema,
});
export const artifactSchema = z.strictObject({
  sha256: sha256Schema,
  node: z.string().min(1).max(80),
  sharp: z.string().min(1).max(80),
  vips: z.string().min(1).max(80),
});
export const approvalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('product-image-backfill-approval'),
    runId: runIdSchema,
    artifact: artifactSchema,
    profile: imageManifestSchema.shape.profile,
    roots: rootsSchema,
    inventory: z.strictObject({
      sha256: sha256Schema,
      bytes: z.number().int().min(1).max(MAX_INVENTORY),
    }),
    batchSize: batchSchema,
    entries: z.array(entrySchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    if (
      value.entries.length !== value.batchSize ||
      new Set(value.entries.map((entry) => entry.url)).size !==
        value.entries.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Scope must contain exactly the approved unique batch',
      });
  });
export type Approval = z.infer<typeof approvalSchema>;
export const scopeSchema = z.strictObject({
  approvalSha256: sha256Schema,
  approval: approvalSchema,
});
export type Scope = z.infer<typeof scopeSchema>;
export const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  scopeHash: sha256Schema,
  attempt: z.number().int().min(1).max(MAX_ATTEMPTS),
  index: z.number().int().min(0).max(49),
  status: z.enum(['READY', 'UNCHANGED', 'FAILED']),
  code: z
    .string()
    .regex(/^[A-Z_]{1,40}$/)
    .nullable(),
  manifest: imageManifestSchema.nullable(),
  durationMs: z.number().nonnegative(),
});
export type Outcome = z.infer<typeof recordSchema>;
export const checkpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  scopeHash: sha256Schema,
  attempt: z.number().int().min(1).max(MAX_ATTEMPTS),
  cursor: z.number().int().min(0).max(50),
  journalBytes: z.number().int().min(0).max(MAX_JOURNAL),
  journalHash: sha256Schema,
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

export class RunnerError extends Error {
  constructor(readonly code: string) {
    super('Image runner refused: ' + code);
  }
}
export const jsonBytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value) + '\n');
export const equal = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
