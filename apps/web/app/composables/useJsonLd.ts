import type { MaybeRefOrGetter } from "vue";
import { serializeJsonLd } from "~/utils/seo";

export function useJsonLd(value: MaybeRefOrGetter<unknown>) {
  useHead(() => ({ script: [{
    key: "page-jsonld",
    type: "application/ld+json",
    innerHTML: serializeJsonLd(toValue(value)),
  }] }));
}
