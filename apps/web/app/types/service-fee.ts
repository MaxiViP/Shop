import type { Unit } from './product';
export type ServiceFeeMode = 'global' | 'individual' | 'review';
export interface ServiceFeeFilter {
  search?: string; category?: number; marketPoint?: number; priceStatus?: string;
  active?: string; settlementMode?: string; hitMode?: string; seasonTemplateId?: number;
  serviceFeeMode?: ServiceFeeMode;
}
export type BulkSelection = { kind: 'ids'; ids: number[] } | { kind: 'filter'; filter: ServiceFeeFilter };
export interface BulkFeeRow {
  id:number; name:string; sellerPrice:number; priceQty:number; unit:Unit;
  before:{mode:'global'|'individual';override:number|null;percent:number;customerPrice:number;needsReview:boolean};
  after:{mode:'global';override:null;percent:number;customerPrice:number;needsReview:false};
  difference:number;differenceBps:number;changed:boolean;
}
export interface BulkFeePreview {
  previewToken:string;expiresAt:string;globalPercent:number;count:number;changedCount:number;rows:BulkFeeRow[];
  totals:{beforePrice:number;afterPrice:number;difference:number;differenceBps:number};
}
export interface BulkFeeResult {
  requestId:string;count:number;changedCount:number;skippedCount:number;globalPercent:number;appliedAt:string;productIds:number[];
}
