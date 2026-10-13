import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { PrismaClient, Prisma } from '../../src/db/gen/client.js';
import { quantityErrors } from '../../src/order/assembly.js';
import { saleErrors, saleModels } from '../../src/product/sale.js';

const unit = z.enum(['GRAM', 'PIECE', 'BUNCH', 'PACK']);
const qty = z.number().int().positive().max(1_000_000);
const fields = z.strictObject({
  unit,
  priceQty: qty,
  min: qty,
  step: qty,
  portionQty: qty,
  saleModel: z.enum(saleModels).nullable(),
  priceUnit: unit.nullable(),
});
const schema = z.strictObject({
  version: z.literal(1),
  localOnly: z.literal(true),
  databaseCheckedAt: z.iso.datetime(),
  patches: z.array(
    z.strictObject({
      productId: z.number().int().positive(),
      slug: z.string().min(1),
      name: z.string().min(1),
      expectedUpdatedAt: z.iso.datetime(),
      sourceUrl: z.string().nullable().optional(),
      before: fields,
      after: fields,
      status: z.literal('CONFIRMED'),
      evidenceIds: z.array(z.string().min(1)).min(1),
    }),
  ),
});
export async function readPlan(file?: string) {
  const path = file ?? new URL(
    '../../../../docs/catalog-sale-audit/plan.json',
    import.meta.url,
  );
  return schema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
}
export type SalePlan = z.infer<typeof schema>;
const select = {
  id: true,
  slug: true,
  name: true,
  unit: true,
  priceQty: true,
  min: true,
  step: true,
  portionQty: true,
  saleModel: true,
  priceUnit: true,
  wholeLabel: true,
  estimatedWeightGrams: true,
  sourceUrl: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;
export async function applyPlan(
  db: PrismaClient,
  input: SalePlan,
  apply = false,
) {
  const plan = schema.parse(input);
  if (
    new Set(plan.patches.map((row) => row.productId)).size !==
      plan.patches.length ||
    new Set(plan.patches.map((row) => row.slug)).size !== plan.patches.length
  )
    throw new Error('Duplicate product identities in plan');
  return db.$transaction(
    async (tx) => {
      if (!apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const changes = [];
      for (const patch of [...plan.patches].sort(
        (a, b) => a.productId - b.productId,
      )) {
        if (apply)
          await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${patch.productId} FOR UPDATE`;
        const current = await tx.product.findUnique({
          where: { id: patch.productId },
          select,
        });
        if (
          !current ||
          current.slug !== patch.slug ||
          current.name !== patch.name ||
          current.sourceUrl !== (patch.sourceUrl ?? null)
        ) {
          changes.push({
            productId: patch.productId,
            slug: patch.slug,
            action: 'SKIPPED_IDENTITY_CONFLICT',
            fields: {},
          });
          continue;
        }
        const keys = Object.keys(patch.after) as (keyof typeof patch.after)[];
        if (keys.every((key) => current[key] === patch.after[key])) {
          changes.push({
            productId: patch.productId,
            slug: patch.slug,
            action: 'UNCHANGED',
            fields: {},
          });
          continue;
        }
        if (
          current.updatedAt.toISOString() !== patch.expectedUpdatedAt ||
          !keys.every((key) => current[key] === patch.before[key])
        ) {
          changes.push({
            productId: patch.productId,
            slug: patch.slug,
            action: 'SKIPPED_ADMIN_CHANGE',
            fields: {},
          });
          continue;
        }
        if (
          Object.keys({
            ...quantityErrors(patch.after),
            ...saleErrors({ ...current, ...patch.after }),
          }).length
        )
          throw new Error(`Invalid sale configuration: ${patch.slug}`);
        // This audit only confirms an identity conversion from an existing priced SKU to one pack.
        // Future gram/count conversions require another reviewed plan and an explicit mathematical proof.
        if (
          patch.before.unit !== 'PIECE' ||
          patch.after.unit !== 'PACK' ||
          patch.before.priceQty !== 1 ||
          patch.after.priceQty !== 1 ||
          (['min', 'step', 'portionQty'] as const).some(
            (key) => patch.before[key] !== patch.after[key],
          )
        )
          throw new Error(`Unproven price/quantity conversion: ${patch.slug}`);
        const diff = Object.fromEntries(
          keys
            .filter((key) => current[key] !== patch.after[key])
            .map((key) => [
              key,
              { before: current[key], after: patch.after[key] },
            ]),
        );
        changes.push({
          productId: patch.productId,
          slug: patch.slug,
          action: apply ? 'APPLIED' : 'WOULD_APPLY',
          fields: diff,
        });
      }
      const preview = {
        apply,
        localOnly: true,
        changes,
        changed: changes.filter((row) =>
          ['APPLIED', 'WOULD_APPLY'].includes(row.action),
        ).length,
        skipped: changes.filter((row) => row.action.startsWith('SKIPPED'))
          .length,
        unchanged: changes.filter((row) => row.action === 'UNCHANGED').length,
      };
      if (apply) {
        // Print the complete plan before the first write. No prices, images, activation or point assignments are written.
        console.log(
          JSON.stringify({ ...preview, phase: 'BEFORE_WRITE' }, null, 2),
        );
        for (const change of changes.filter(
          (row) => row.action === 'APPLIED',
        )) {
          const patch = plan.patches.find(
            (row) => row.productId === change.productId,
          )!;
          const data = Object.fromEntries(
            Object.keys(change.fields).map((key) => [
              key,
              patch.after[key as keyof typeof patch.after],
            ]),
          );
          await tx.product.update({
            where: {
              id: patch.productId,
              slug: patch.slug,
              updatedAt: patch.expectedUpdatedAt,
            },
            data,
          });
        }
      }
      return preview;
    },
    { isolationLevel: 'Serializable', timeout: 30000 },
  );
}
