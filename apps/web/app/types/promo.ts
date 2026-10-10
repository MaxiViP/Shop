export type PromoStatus = 'AVAILABLE' | 'USED' | 'EXPIRED' | 'REVOKED';
export interface PersonalPromo {
  id: number; code: string; title: string; type: 'FIXED' | 'PERCENT';
  amount: number | null; percentBps: number | null; maxDiscount: number | null;
  minSubtotal: number; expiresAt: string; status: PromoStatus; usedAt: string | null;
  usedOrder: { publicId: string } | null;
}
export interface PromoOption extends PersonalPromo {
  eligible: boolean; reason: string | null; discount: number;
}
export interface OrderPromo {
  promoCodeSnapshot?: string | null; promoTitleSnapshot?: string | null;
  promoDiscount?: number; finalPromoDiscount?: number | null;
}
export interface AdminPromo extends PersonalPromo {
  reason: string; sourceOrderId: number | null; createdAt: string;
  user: { id: number; name: string | null; phone: string | null };
  usedOrder: { id: number; publicId: string } | null;
  orders: { id: number; status: string; createdAt: string; promoDiscount: number; finalPromoDiscount: number | null }[];
}
