<template>
  <nav class="sections" aria-label="Разделы заказа">
    <NuxtLink
      v-for="link in links"
      :key="link.hash"
      :to="{ path: route.path, hash: link.hash }"
      class="sections__link"
      :class="{ 'sections__link--active': current === link.hash }"
      :aria-current="current === link.hash ? 'location' : undefined"
    >{{ link.label }}</NuxtLink>
  </nav>
</template>

<script setup lang="ts">
const props = defineProps<{
  links: { hash: string; label: string }[];
  initialHash: string;
}>();
const route = useRoute();
const current = computed(() => route.hash || props.initialHash);
</script>

<style scoped>
.sections {
  position: sticky;
  z-index: 18;
  top: var(--header-height);
  display: flex;
  gap: 0.25rem;
  min-width: 0;
  max-width: 100%;
  margin-block: 0.75rem;
  padding: 0.3rem;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
  background: var(--ui-bg-elevated);
  box-shadow: 0 8px 20px rgb(0 0 0 / 12%);
}
.sections__link {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-height: var(--touch-target);
  padding-inline: 0.75rem;
  border-radius: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
}
.sections__link:hover,
.sections__link:focus-visible,
.sections__link--active {
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg));
}
.sections__link:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
@media (min-width: 48rem) {
  .sections { position: static; overflow: visible; }
  .sections__link { flex: 1 1 0; white-space: normal; text-align: center; }
}
</style>
