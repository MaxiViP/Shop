export interface FinanceTotals {
  turnover: number; goodsRevenue: number; sharedRevenue: number;
  noMarkupRevenue: number; unsetRevenue: number; legacyRevenue: number;
  legacyItemsCount: number; baseAmount: number; sharedMarkup: number;
  partner1Share: number; partner2Share: number; delivery: number; extras: number;
}
export interface FinanceDay extends FinanceTotals { date: string; ordersCount: number }
export interface FinanceReport extends FinanceTotals {
  period: { from: string; to: string; timezone: string };
  partnerNames: [string, string]; ordersCount: number; averageCheck: number;
  cancelled: { count: number; amount: number };
  legacyCompletedCount: number; unreconciledOrdersCount: number; days: FinanceDay[];
}
export interface FinanceLine {
  id: number; productName: string; mode: 'SHARED_MARKUP' | 'NO_MARKUP' | 'UNSET' | 'LEGACY';
  qty: number; saleAmount: number; baseAmount: number; sharedMarkup: number;
  orderPrice: number; finalPrice: number; priceQty: number;
}
export interface FinanceDayOrder {
  id: number; publicId: string; completedAt: string; customerName: string;
  lines: FinanceLine[]; totals: FinanceTotals; finalTotal: number | null;
}
export interface ShopStatus {
  isOpen: boolean; timezone: string; today: string;
  openTime: string | null; closeTime: string | null; nextOpenAt: string | null;
}
export interface ShopHours { weekday: number; enabled: boolean; openMinutes: number; closeMinutes: number }
export interface ShopHoursException {
  id: number; date: string; closed: boolean; openMinutes: number | null;
  closeMinutes: number | null; note: string | null;
}
export interface ScheduleData {
  weekly: ShopHours[]; exceptions: ShopHoursException[]; status: ShopStatus;
}
export interface AdminOrderRow {
  id: number; publicId: string; createdAt: string; completedAt: string | null;
  customerName: string; customerPhone: string; type: 'DELIVERY' | 'PICKUP';
  deliveryAt: string | null; total: number | null; finalTotal: number | null;
  status: string; payment: { status: string } | null; userId: number | null;
}
export interface AdminOrderDetail extends AdminOrderRow {
  subtotal: number;
  promoCodeSnapshot?: string | null; promoTitleSnapshot?: string | null;
  promoDiscount?: number; finalPromoDiscount?: number | null;
  items: { id: number; productName: string; qty: number; actualQty: number | null;
    total: number; actualTotal: number | null; status: string; unit: string;
    price: number; actualPrice: number | null; priceQty: number }[];
  city: string | null; street: string | null; house: string | null;
  buildingPart?: string | null;
  flat: string | null; comment: string | null;
  deliveryPrice: number | null; finalSubtotal: number | null;
  purchaser: { id: number; name: string | null; phone: string | null } | null;
  finance: { lines: FinanceLine[]; totals: FinanceTotals };
  extras: { id: number; title: string; amount: number; status: string }[];
  issues: { id: number; type: string; status: string; resolution: string | null }[];
  messages: { id: number; text: string; createdAt: string }[];
  history: { id: number; action: string; createdAt: string }[];
  priceChanges: { id: number; itemId: number; previousPrice: number; newPrice: number;
    reason: string | null; createdAt: string; item: { productName: string };
    actor: { name: string | null; role: string } }[];
}
export interface Payout {
  id: number; partner: number; periodFrom: string; periodTo: string;
  amount: number; paidAt: string; comment: string | null;
  createdById: number; createdAt: string;
}
