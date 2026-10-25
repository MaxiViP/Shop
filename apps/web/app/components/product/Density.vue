<template>
  <div class="density" :class="{ 'density--all-sizes': scope === 'favorites' }" role="group" aria-label="Количество карточек в ряд">
    <span class="density__label">Карточек в ряд</span>
    <div class="density__options">
      <UButton
        v-for="value in options"
        :key="value"
        class="density__option"
        type="button"
        :color="columns === value ? 'primary' : 'neutral'"
        :variant="columns === value ? 'solid' : 'ghost'"
        :aria-pressed="columns === value"
        :aria-label="`${value} карточки в ряд`"
        @click="select(value)"
      >
        {{ value }}
      </UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
const { scope = 'catalog' } = defineProps<{ scope?: 'catalog' | 'favorites' }>();
const { columns, select } = useMobileGrid(scope);
const options = [2, 3, 4] as const;
</script>

<style scoped>
.density { display: none; }
.density--all-sizes { display: grid; justify-items: center; gap: 0.25rem; }
.density__label { color: var(--ui-text-muted); font-size: 0.6875rem; line-height: 1.2; white-space: nowrap; }
.density__options { display: flex; gap: 0.125rem; padding: 0.125rem; border-radius: 0.625rem; background: var(--ui-bg-elevated); }
.density__option { justify-content: center; width: var(--touch-target); min-width: 0; height: 2.25rem; min-height: 2.25rem; padding: 0; border-radius: 0.5rem; font-size: 0.875rem; }
@media (width < 40rem) { .density { display: grid; justify-items: center; justify-self: center; gap: 0.25rem; } }
</style>
