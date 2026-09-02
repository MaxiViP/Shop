<template>
  <div class="qty">
    <UButton
      icon="i-lucide-minus"
      variant="soft"
      color="neutral"
      :disabled="value <= product.min"
      aria-label="Уменьшить"
      @click="dec"
    />

    <span class="qty__value">
      {{ label }}
    </span>

    <UButton
      icon="i-lucide-plus"
      variant="soft"
      color="neutral"
      aria-label="Увеличить"
      @click="inc"
    />
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";
import { qtyText } from "~/utils/qty";

const { product } = defineProps<{
  product: ProductListItem;
}>();

const value = defineModel<number>({ required: true });

function dec() {
  value.value = Math.max(product.min, value.value - product.step);
}

function inc() {
  value.value += product.step;
}

const label = computed(() => qtyText(product.unit, value.value));
</script>

<style scoped>
.qty {
  display: flex;
  max-width: 100%;
  align-items: center;
  gap: 0.25rem;
}

.qty :deep(button) {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
  flex: 0 0 auto;
}

.qty__value {
  min-width: 3.5rem;
  text-align: center;
  font-weight: 600;
  overflow-wrap: anywhere;
}

@media (min-width: 40rem) {
  .qty {
    gap: 0.75rem;
  }

  .qty__value {
    min-width: 5rem;
  }
}
</style>
