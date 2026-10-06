export type MarketPointKind = 'STALL' | 'STORE' | 'FOODCOURT' | 'SERVICE' | 'OTHER' | 'ENTRY';

export interface MarketPoint {
  id: number;
  slug: string;
  name: string;
  unitNumber: string | null;
  kind: MarketPointKind;
  description: string | null;
  sampleAssortment: string | null;
  photoUrl: string | null;
  floor: number;
  mapX: number;
  mapY: number;
  isPublished: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type MarketMarker = Pick<MarketPoint,
  'id' | 'slug' | 'name' | 'unitNumber' | 'kind' | 'mapX' | 'mapY' | 'isPublished'>;
export type MarketPointInput = Omit<MarketPoint, 'id' | 'photoUrl' | 'createdAt' | 'updatedAt'>;
