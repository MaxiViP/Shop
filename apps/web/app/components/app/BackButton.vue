<template>
  <UButton
    type="button"
    class="back-button"
    icon="i-lucide-arrow-left"
    color="neutral"
    variant="ghost"
    @click="goBack"
    >{{ label }}</UButton
  >
</template>

<script setup lang="ts">
import { backTarget } from "~/utils/back";
const props = withDefaults(
  defineProps<{ fallback: string; label?: string }>(),
  { label: "Назад" },
);
const router = useRouter();
const route = useRoute();

function goBack() {
  const target = backTarget(
    router.options.history.state.back,
    route.fullPath,
    props.fallback,
    (path) => router.resolve(path).matched.length > 0,
  );
  if (target === null) router.back();
  else return router.replace(target);
}
</script>

<style scoped>
.back-button {
  display: inline-flex;
  min-width: 44px;
  min-height: 44px;
  align-items: center;
  justify-self: start;
  gap: 0.5rem;
  color: var(--ui-text-muted);
}
.back-button :deep(.iconify) {
  width: 1.25rem;
  height: 1.25rem;
}
.back-button:hover,
.back-button:active {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}
.back-button:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
</style>
