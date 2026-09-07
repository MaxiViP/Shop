<template>
  <div class="layout">
    <AppHeader />

    <main
      class="layout__main"
      :class="{ 'layout__main--search': bottomSearch }"
    >
      <slot />
    </main>
    <AppBottomSearch v-if="bottomSearch" />
  </div>
</template>

<script setup lang="ts">
import { showBottomSearch } from "~/utils/search";
const route = useRoute();
const bottomSearch = computed(() => showBottomSearch(route.path));
</script>

<style scoped>
.layout {
  min-height: 100vh;
}

.layout__main {
  min-height: calc(100dvh - var(--header-height));
}
@media (max-width: 47.999rem) {
  .layout__main--search {
    padding-bottom: calc(5rem + var(--safe-bottom));
  }
}
</style>
