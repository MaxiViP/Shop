import { computed, ref, watch } from "vue";
import { useCartStore } from "~/stores/cart";

// One scene follows confirmed additions. Restores and server refreshes do not animate.
export function useBasketScene() {
  const cart = useCartStore();
  const sceneKey = ref(0);
  const animating = ref(false);
  const sceneState = computed(() =>
    cart.count === 0 ? "empty" : animating.value ? "animate" : "full",
  );

  watch(() => cart.additionRevision, (revision) => {
    if (!cart.restored || cart.count === 0) return;
    sceneKey.value = revision;
    animating.value = true;
  });

  watch([() => cart.restored, () => cart.count], ([restored, count]) => {
    if (!restored || count === 0) animating.value = false;
  });

  return { sceneKey, sceneState };
}
