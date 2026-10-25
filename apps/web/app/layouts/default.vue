<template>
  <div class="layout">
    <div class="layout__bottom-controls">
      <AppBottomSearch v-if="bottomSearch" />
      <div id="floating-cart-anchor" class="floating-cart-anchor" />
    </div>
    <AppHeader />

    <main
      class="layout__main"
    >
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import { showBottomSearch } from "~/utils/search";
useCartQuote();
const route = useRoute();
const bottomSearch = computed(() => showBottomSearch(route.path));
</script>

<style scoped>
.layout {
  --bottom-control-height: 3.5rem;
  --bottom-controls-offset: 0px;
  min-height: 100vh;
}
.layout__bottom-controls { display: none; }
.floating-cart-anchor { flex: none; margin-left: auto; pointer-events: auto; }
/* Match the space reserved by checkout for its fixed submit panel. */
.layout:has(.checkout .summary__submit) { --bottom-controls-offset: 6rem; }
.layout:has(.checkout--delivery-notice .summary__submit) { --bottom-controls-offset: 9rem; }

.layout__main {
  min-height: calc(100dvh - var(--header-height));
}
@media (width < 768px), (orientation: landscape) and (pointer: coarse) {
  .layout__bottom-controls {
    position: fixed;
    left: max(0.75rem, var(--safe-left));
    right: max(0.75rem, var(--safe-right));
    bottom: calc(0.75rem + var(--safe-bottom) + var(--bottom-controls-offset));
    z-index: 31;
    display: flex;
    align-items: end;
    gap: 0.5rem;
    pointer-events: none;
  }
  .layout__main {
    padding-bottom: calc(5rem + var(--safe-bottom));
  }
}
</style>
