import { z } from 'zod';

export function safeSlideLink(value: string) {
  if (value.includes('\\') || [...value].some(char => char.charCodeAt(0) <= 32)) return false;
  if (value.startsWith('/')) {
    try { return !decodeURIComponent(value).startsWith('//') && !decodeURIComponent(value).includes('\\'); }
    catch { return false; }
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

const fields = z.strictObject({
  type: z.enum(['PERMANENT', 'TEMPORARY']),
  content: z.enum(['CUSTOM', 'FREE_DELIVERY', 'SEASONAL', 'HITS']),
  title: z.string().trim().min(1).max(140),
  text: z.string().trim().max(420),
  eyebrow: z.string().trim().max(60).nullable(),
  buttonLabel: z.string().trim().min(1).max(50).nullable(),
  to: z.string().trim().max(2000).refine(safeSlideLink, 'Используйте путь сайта или HTTPS-ссылку.').nullable(),
  image: z.string().regex(/^\/(?:images\/hero\/hero-[0-3]\.webp|uploads\/products\/hero\/[a-f0-9-]{36}\.webp)$/).nullable(),
  position: z.enum(['center', 'left center', 'right center', 'center top', 'center bottom']),
  active: z.boolean(),
  published: z.boolean(),
  priority: z.boolean(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
});

export const slideSchema = fields.superRefine((data, ctx) => {
  if (data.startsAt && data.endsAt && new Date(data.endsAt) <= new Date(data.startsAt))
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Окончание должно быть позже начала.' });
  if (data.published && data.type === 'TEMPORARY' && !data.endsAt)
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Для временной публикации укажите окончание.' });
  if (Boolean(data.buttonLabel) !== Boolean(data.to))
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Укажите и текст кнопки, и ссылку либо уберите оба поля.' });
  if (data.content === 'FREE_DELIVERY' && !data.title.includes('{threshold}'))
    ctx.addIssue({ code: 'custom', path: ['title'], message: 'В заголовке нужен шаблон {threshold} — актуальный порог из настроек.' });
});
export const slidePatch = fields.partial();
export type SlideInput = z.infer<typeof slideSchema>;
export const reorderSchema = z.strictObject({ ids: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(40)
  .refine(ids => new Set(ids).size === ids.length, 'Слайд не должен повторяться.') });
