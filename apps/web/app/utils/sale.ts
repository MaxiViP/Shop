import { variableWeight, type Sale } from '../../../api/src/product/sale.ts';

export {
  compatibleQuantityUnit, variableWeight, saleModel, priceUnit, saleErrors, saleModels, wholeLabels, saleTermsChanged,
  estimatedQuantity, actualQuantity, needsWeightApproval, approvedItemWeight,
} from '../../../api/src/product/sale.ts';
export type { Sale, SaleModel } from '../../../api/src/product/sale.ts';

export function saleExplanation(product: Sale): string | null {
  if (!variableWeight(product)) return null;
  const quantity = product.unit === 'BUNCH' ? 'пучками' : 'поштучно, целиком';
  return `Цена за килограмм. Продаётся ${quantity}. При сборке взвесим товар и рассчитаем стоимость по фактическому весу.`;
}
