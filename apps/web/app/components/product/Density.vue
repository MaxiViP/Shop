<template>
  <div class="density" role="group" aria-label="Количество карточек в ряд">
    <UButton
      v-for="value in options"
      :key="value"
      class="density__option"
      type="button"
      color="neutral"
      :variant="columns === value ? 'solid' : 'soft'"
      :aria-pressed="columns === value"
      :aria-label="`${value} карточки в ряд`"
      :title="`${value} карточки в ряд`"
      @click="select(value)"
    >
      <svg class="density__icon" viewBox="0 0 28 12" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true" focusable="false">
        <rect v-for="square in value" :key="square" :x="1 + (4 - value) * 3.5 + (square - 1) * 7" y="3.5" width="5" height="5" rx="0.5" />
      </svg>
    </UButton>
  </div>
</template>

<script setup lang="ts">
const { columns, select } = useMobileGrid();
const options = [2, 3, 4] as const;
</script>

<style scoped>
.density { display: none; }
.density__option { justify-content: center; width: 2.25rem; min-width: 0; min-height: var(--touch-target); padding-inline: 0; }
.density__icon { width: 1.75rem; height: 0.75rem; flex: none; }
@media (width < 40rem) { .density { display: inline-flex; justify-self: center; gap: 0.125rem; } }
</style>
