export type SlideType = 'PERMANENT' | 'TEMPORARY';
export type SlideContent = 'CUSTOM' | 'FREE_DELIVERY' | 'SEASONAL' | 'HITS';
export type SlideStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'DISABLED';

export interface PublicHomeSlide {
  id: number;
  content: SlideContent;
  title: string;
  text: string;
  eyebrow: string | null;
  image: string | null;
  position: string;
  buttonLabel: string | null;
  to: string | null;
  endsAt: string | null;
}
export interface HomeSlidesResponse {
  slides: PublicHomeSlide[];
  serverNow: string;
  validUntil: string;
}
export interface SlideInput {
  type: SlideType;
  content: SlideContent;
  title: string;
  text: string;
  eyebrow: string | null;
  buttonLabel: string | null;
  to: string | null;
  image: string | null;
  position: string;
  active: boolean;
  published: boolean;
  priority: boolean;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
}
export interface AdminHomeSlide extends SlideInput {
  id: number;
  status: SlideStatus;
}
