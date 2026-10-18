import type { ProductImage } from '../types/product';

export type ProductImageContext = 'card' | 'compact' | 'thumbnail' | 'original';
export interface ProductImageAttrs { src?: string; srcset?: string; sizes?: string }
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const sourcePath = new RegExp('^/uploads/products/(' + uuid + ')\\.webp$');
const variantPath = new RegExp(
  '^/uploads/products/variants/v1/(' + uuid + ')/([a-f0-9]{64})/(192|384|640)(?:-[a-f0-9]{64})?\\.webp$',
);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const dimension = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

export function productImageVariantsEnabled(value: unknown) {
  return value === true || value === 'true';
}

// Nuxt UI 4: --ui-container:80rem. app.config overrides container padding
// with --page-x; Grid.vue supplies columns/gaps and Card.vue a 1px border.
const grid = [[96, 7, .75], [80, 6, .75], [64, 5, .75], [48, 4, .5], [40, 3, .5], [0, 2, .375]] as const;
export function productImageSizes(context: ProductImageContext, ratio = 1) {
  const scale = (value: string, factor: number) =>
    factor === 1 ? value : 'calc((' + value + ') * ' + Number(factor.toFixed(8)) + ')';
  if (context === 'thumbnail')
    return scale('calc(3.6rem - 4px)', Math.max(1, ratio)); // cover: 4rem minus padding/borders
  return [true, false].flatMap((landscape) => grid.map(([breakpoint, columns, gap]) => {
    const media = [
      ...(landscape ? ['(orientation: landscape)', '(pointer: coarse)', '(max-height: 500px)'] : []),
      ...(breakpoint ? ['(min-width: ' + breakpoint + 'rem)'] : []),
    ].join(' and ');
    // Safe-area padding and a scrollbar can only make the real box smaller.
    // Omit env() for a portable conservative bound in HTML sizes (no CSS vars).
    const padding = landscape ? '1rem' : 'clamp(0.75rem, 0.4rem + 1.5vw, 2rem)';
    const box = 'calc((min(100vw, 80rem) - 2 * ' + padding + ' - ' +
      (columns - 1) * gap + 'rem) / ' + columns + ' - 2px)';
    const factor = Math.min(1, ratio * (context === 'compact' && !breakpoint ? .75 : 1));
    return (media ? media + ' ' : '') + scale(box, factor);
  })).join(', ');
}

export function productImageAttrs(
  image: ProductImage | null | undefined,
  asset: (url: string) => string,
  context: ProductImageContext,
  enabled: boolean,
): ProductImageAttrs {
  if (!image || typeof image.url !== 'string' || !image.url) return {};
  const legacy = { src: asset(image.url) };
  if (!enabled || context === 'original') return legacy;
  try {
    const source = sourcePath.exec(image.url);
    const variants: unknown = image.variants;
    if (!source || source[0] !== image.url || !record(variants) ||
      variants.version !== 'v1' || !Array.isArray(variants.webp) ||
      !variants.webp.length || variants.webp.length > 3) return legacy;
    const dimensions = dimension(image.width, 16384) && dimension(image.height, 16384) &&
      image.width * image.height <= 25_000_000 ? { width: image.width, height: image.height } : null;
    if ((image.width !== undefined || image.height !== undefined) && !dimensions) return legacy;
    const candidates = new Map<number, string>();
    const hashes = new Set<string>();
    for (const entry of variants.webp) {
      if (!record(entry) || typeof entry.url !== 'string') continue;
      const path = variantPath.exec(entry.url);
      if (!path || path[0] !== entry.url || path[1] !== source[1]) continue;
      const bound = Number(path[3]);
      if (!dimension(entry.width, bound) || !dimension(entry.height, bound)) continue;
      if (dimensions) {
        const factor = Math.min(1, bound / dimensions.width, bound / dimensions.height);
        if (entry.width > dimensions.width || entry.height > dimensions.height ||
          Math.abs(entry.width - dimensions.width * factor) > 1 ||
          Math.abs(entry.height - dimensions.height * factor) > 1) continue;
      }
      hashes.add(path[2]!);
      if (!candidates.has(entry.width)) candidates.set(entry.width, asset(entry.url));
    }
    if (!candidates.size || hashes.size !== 1) return legacy;
    // Prefer the original at an equal native width, including tiny sources.
    if (dimensions) candidates.set(dimensions.width, legacy.src);
    return {
      ...legacy,
      srcset: [...candidates].sort(([a], [b]) => a - b).map(([width, url]) => url + ' ' + width + 'w').join(', '),
      sizes: productImageSizes(context, dimensions ? dimensions.width / dimensions.height : 1),
    };
  } catch { return legacy; }
}
