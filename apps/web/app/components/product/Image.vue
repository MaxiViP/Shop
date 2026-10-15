<template>
  <img v-if="attrs.src && !failed" ref="element" v-bind="{ ...$attrs, ...attrs }" :alt="alt">
  <slot v-else />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { ProductImage } from '~/types/product';
import type { ProductImageContext } from '~/utils/product-image';

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  image?: ProductImage | null;
  alt: string;
  context: ProductImageContext;
  identity?: string | number;
}>();
const { attrs, failed } = useProductImage(() => props.image, () => props.context, () => props.identity);
const element = ref<HTMLImageElement | null>(null);
function checkComplete() {
  const image = element.value;
  // An SSR request may fail before hydration attaches the error listener.
  // Match attributes so the old failed element cannot reject its pending retry.
  if (image?.complete && image.naturalWidth === 0 &&
    image.getAttribute('src') === attrs.value.src &&
    image.getAttribute('srcset') === (attrs.value.srcset ?? null)) attrs.value.onError();
}
onMounted(checkComplete);
watch(element, checkComplete, { flush: 'post' });
</script>
