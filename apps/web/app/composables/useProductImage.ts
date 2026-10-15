import { computed, shallowRef, watch } from 'vue';
import type { ProductImage } from '../types/product';
import { productImageAttrs, productImageVariantsEnabled, type ProductImageContext } from '../utils/product-image.ts';

export function useProductImage(
  image: () => ProductImage | null | undefined,
  context: () => ProductImageContext,
  identity: () => unknown,
) {
  const config = useRuntimeConfig();
  const asset = useAsset();
  const state = shallowRef({ generation: 0, phase: 0 });
  watch(() => [identity(), image(), image()?.url], () => {
    state.value = { generation: state.value.generation + 1, phase: 0 };
  }, { flush: 'sync' });
  const attrs = computed(() => {
    const current = state.value;
    const enabled = productImageVariantsEnabled(config.public.productImageVariants);
    const result = productImageAttrs(image(), asset, context(), enabled && current.phase === 0);
    return {
      ...result,
      ...(enabled ? { decoding: 'async' as const } : {}),
      // Replace the failed element once: its queued errors cannot affect the retry.
      key: current.generation + ':' + current.phase,
      onError: () => {
        if (state.value !== current || current.phase === 2) return;
        state.value = { generation: current.generation, phase: result.srcset ? 1 : 2 };
      },
    };
  });
  return { attrs, failed: computed(() => state.value.phase === 2) };
}
