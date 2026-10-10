import type { Unit } from './product';

export type SeasonalMode = 'AUTO' | 'MANUAL' | 'OFF';
export type HitMode = 'AUTO' | 'MANUAL' | 'OFF';
export type SeasonGroup = 'VEGETABLES' | 'FRUITS' | 'BERRIES';
export interface SeasonPreset {
  key: string;
  name: string;
  description: string;
  group: SeasonGroup;
  startMonth: number;
  endMonth: number;
  active: boolean;
}
export interface SeasonTemplate {
  id: number;
  key: string | null;
  name: string;
  description: string | null;
  group: SeasonGroup | null;
  startMonth: number;
  endMonth: number;
  active: boolean;
  _count: { products: number };
}
export interface HitSettings {
  periodDays: number;
  minOrders: number;
  shareBps: number;
  lastCalculatedAt: string | null;
}
export interface HitProduct {
  id: number;
  name: string;
  unit: Unit;
  category: { id: number; name: string };
  hitOrders: number;
  hitSoldUnits: string;
  hitRank: number | null;
  isHit: boolean;
  autoHit: boolean;
  hitMode: HitMode;
}
