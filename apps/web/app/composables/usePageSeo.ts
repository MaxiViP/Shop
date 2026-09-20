import type { MaybeRefOrGetter } from "vue";
import { publicImageUrl } from "~/utils/seo";
import { site } from "~~/shared/utils/site";

export function usePageSeo(input: MaybeRefOrGetter<{
  title: string;
  description: string;
  image?: string;
  indexable?: boolean;
}>) {
  const value = computed(() => toValue(input));
  useSeoMeta({
    title: () => value.value.title,
    description: () => value.value.description,
    ogTitle: () => value.value.title,
    ogDescription: () => value.value.description,
    ogImage: () => publicImageUrl(value.value.image || `${site.url}/images/hero/hero-0.webp`),
    twitterCard: "summary_large_image",
  });
  useHead(() => ({ meta: value.value.indexable === false
    ? [{ name: "robots", content: "noindex, follow" }]
    : [],
  }));
}
