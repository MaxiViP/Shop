<template>
  <img v-if="attrs.src && !failed" ref="element" v-bind="{ ...$attrs, ...attrs, ...loadingAttrs }" :alt="alt">
  <slot v-else />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ProductImage } from '~/types/product';
import type { ProductImageContext } from '~/utils/product-image';

defineOptions({ inheritAttrs: false });
const props = defineProps<{
  image?: ProductImage | null;
  alt: string;
  context: ProductImageContext;
  identity?: string | number;
  eagerImage?: boolean;
}>();
const { attrs, failed } = useProductImage(() => props.image, () => props.context, () => props.identity);
const element = ref<HTMLImageElement | null>(null);
const catalog = computed(() => props.context === 'card' || props.context === 'compact');
const near = ref(false);
const loadingAttrs = computed(() => catalog.value ? {
  fetchpriority: props.eagerImage ? 'high' : 'auto',
  loading: props.eagerImage || near.value ? 'eager' : 'lazy',
  decoding: props.eagerImage ? 'auto' : 'async',
} as const : {});
let observer: IntersectionObserver | undefined;
function observe() {
  observer?.disconnect();
  observer = undefined;
  const image = element.value;
  if (!image || !catalog.value || props.eagerImage || typeof IntersectionObserver === 'undefined') return;
  const current = new IntersectionObserver(entries => {
    if (element.value !== image || !entries.some(entry => entry.isIntersecting)) return;
    near.value = true;
    current.disconnect();
  }, { rootMargin: '3000px 0px' });
  observer = current;
  current.observe(image);
}
function checkComplete() {
  const image = element.value;
  // An SSR request may fail before hydration attaches the error listener.
  // Match attributes so the old failed element cannot reject its pending retry.
  if (image?.complete && image.naturalWidth === 0 &&
    image.getAttribute('src') === attrs.value.src &&
    image.getAttribute('srcset') === (attrs.value.srcset ?? null)) attrs.value.onError();
}
onMounted(() => { checkComplete(); observe(); });
watch(element, () => { checkComplete(); observe(); }, { flush: 'post' });
watch(() => [props.identity, props.image?.url, props.eagerImage], () => {
  near.value = false;
  observe();
}, { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());
</script>
