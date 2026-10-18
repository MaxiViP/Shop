// Full-frame variants preserve cover cropping and every authored object-position.
// Unknown/admin-uploaded URLs deliberately retain their original image.
export function heroImage(image: string | null | undefined, coverWidth = 0) {
  if (image !== '/images/hero/hero-0.webp') return;
  const base = '/images/hero/hero-0';
  return {
    width: 1672,
    height: 941,
    srcset: `${base}-840.webp 840w, ${base}-1200.webp 1200w, ${base}.webp 1672w`,
    avifSrcset: [840, 1200, 1672].map(width => `${base}-${width}.avif ${width}w`).join(', '),
    // SSR reserves room for the compact feature/longest slide. After mount the
    // actual cover width is used; the browser applies DPR, up to the original.
    sizes: coverWidth ? `${Math.ceil(coverWidth)}px` : '(min-width: 1280px) 1280px, (min-width: 768px) 1024px, 1200px',
  };
}
