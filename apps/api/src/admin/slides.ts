import type { HomeSlide } from '../db/gen/client.js';

export function slideStatus(slide: Pick<HomeSlide, 'published' | 'active' | 'startsAt' | 'endsAt'>, now: Date) {
  if (!slide.published) return 'DRAFT';
  if (!slide.active) return 'DISABLED';
  if (slide.endsAt && slide.endsAt <= now) return 'ENDED';
  if (slide.startsAt && slide.startsAt > now) return 'SCHEDULED';
  return 'ACTIVE';
}

type Conditions = { freeDeliveryThreshold: number | null; seasonal: boolean; hits: boolean };

export function renderSlide(slide: Pick<HomeSlide, 'id' | 'content' | 'title' | 'text' | 'image' | 'position' |
  'eyebrow' | 'buttonLabel' | 'to' | 'endsAt'>, conditions: Conditions) {
  if (slide.content === 'FREE_DELIVERY' && conditions.freeDeliveryThreshold === null) return null;
  if (slide.content === 'SEASONAL' && !conditions.seasonal) return null;
  if (slide.content === 'HITS' && !conditions.hits) return null;
  const threshold = conditions.freeDeliveryThreshold === null ? '' :
    new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 })
      .format(conditions.freeDeliveryThreshold / 100);
  const text = (value: string) => slide.content === 'FREE_DELIVERY' ? value.replaceAll('{threshold}', threshold) : value;
  return { id: slide.id, content: slide.content, title: text(slide.title), text: text(slide.text),
    image: slide.image, position: slide.position, eyebrow: slide.eyebrow, buttonLabel: slide.buttonLabel,
    to: slide.content === 'SEASONAL' ? '/catalog?tag=seasonal' : slide.content === 'HITS' ? '/catalog?tag=hit' : slide.to,
    endsAt: slide.endsAt };
}
