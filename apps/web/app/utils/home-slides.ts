import type { HomeSlidesResponse, PublicHomeSlide } from '../types/home-slide.ts';

export function heroDuration(slide: Pick<PublicHomeSlide, 'title' | 'text'> | undefined, feature = false) {
  if (feature) return 15_000;
  const words = `${slide?.title ?? ''} ${slide?.text ?? ''}`.trim().split(/\s+/).length;
  return Math.max(8000, Math.min(25_000, words * 300));
}

export function visibleHomeSlides(response: HomeSlidesResponse, now: number | null) {
  // SSR and hydration use the identical server result before the client clock starts.
  if (now === null) return response.slides;
  return response.slides.filter(slide => (!slide.endsAt || Date.parse(slide.endsAt) > now) &&
    (slide.content === 'CUSTOM' || Date.parse(response.validUntil) > now));
}
