import type { Address } from './address';

export type DeliveryAddress = Pick<Address, 'city' | 'street' | 'house'> &
  Partial<Pick<Address, 'id' | 'label' | 'buildingPart' | 'flat' | 'entrance' | 'floor' | 'intercom' | 'comment' | 'lat' | 'lng'>>;

export interface DeliveryEstimate {
  price: number;
  currency: 'RUB';
  calculatedAt: string;
  expiresAt: string;
  sampleWeightGrams: number;
}
