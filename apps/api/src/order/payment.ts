import { ConflictException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../db/gen/client.js';

export const reportSchema = z.strictObject({
  method: z.enum(['SBP', 'QR', 'CARD_TRANSFER']),
});
export const paymentSelect = {
  amount: true,
  status: true,
  method: true,
  reportedAt: true,
  confirmedAt: true,
  confirmedBy: { select: { id: true, name: true } },
} satisfies Prisma.OrderPaymentSelect;

export function requirePaid(order: {
  assemblyFinalizedAt: Date | null;
  finalSubtotal: number | null;
  payment: { status: string; amount: number } | null;
}) {
  if (
    !order.assemblyFinalizedAt ||
    order.finalSubtotal === null ||
    order.payment?.status !== 'PAID' ||
    order.payment.amount !== order.finalSubtotal
  )
    throw new ConflictException(
      'Сначала завершите сборку и подтвердите оплату товаров',
    );
}

export function paymentDetails() {
  const text = (key: string) => process.env[key]?.trim() || null;
  const url = (key: string) => {
    const value = text(key);
    if (!value) return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
      return null;
    }
  };
  const phone = text('PAYMENT_PHONE');
  const cardNumber = text('PAYMENT_CARD_NUMBER');
  const sbpLink = url('PAYMENT_SBP_LINK');
  const qrImageUrl = url('PAYMENT_QR_IMAGE_URL');
  return {
    recipientName: text('PAYMENT_RECIPIENT_NAME'),
    bankName: text('PAYMENT_BANK_NAME'),
    phone,
    cardNumber,
    sbpLink,
    qrImageUrl,
    methods: [
      phone || sbpLink ? 'SBP' : null,
      qrImageUrl ? 'QR' : null,
      cardNumber ? 'CARD_TRANSFER' : null,
    ].filter((value): value is string => value !== null),
  };
}
