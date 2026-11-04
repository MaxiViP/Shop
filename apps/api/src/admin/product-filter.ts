import type { Prisma } from '../db/gen/client.js';
import { ownerProductWhere } from '../auth/permissions.js';
import type { ProductFilters } from './schema.js';

// Shared by the paginated list and bulk selection: exactly the same server-side scope.
export function productWhere(
  query: ProductFilters,
  ownerId?: number,
): Prisma.ProductWhereInput {
  const {
    search,
    category,
    active,
    settlementMode,
    marketPoint,
    priceStatus,
    hitMode,
    seasonTemplateId,
    serviceFeeMode,
    serviceMarkupPercent,
  } = query;
  return {
    ...(ownerId ? ownerProductWhere(ownerId) : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(category ? { categoryId: category } : {}),
    ...(marketPoint ? { marketPointId: marketPoint } : {}),
    ...(priceStatus ? { priceStatus } : {}),
    ...(serviceMarkupPercent !== undefined ? { serviceMarkupPercent } : {}),
    ...(hitMode ? { hitMode } : {}),
    ...(seasonTemplateId ? { seasonTemplateId } : {}),
    ...(active ? { active: active === 'true' } : {}),
    ...(settlementMode ? { settlementMode } : {}),
    ...(serviceFeeMode === 'global'
      ? { serviceMarkupPercentOverride: null }
      : {}),
    ...(serviceFeeMode === 'individual'
      ? { serviceMarkupPercentOverride: { not: null } }
      : {}),
    ...(serviceFeeMode === 'review' ? { serviceMarkupNeedsReview: true } : {}),
  };
}
