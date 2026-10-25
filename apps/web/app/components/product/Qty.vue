<template>
  <div class="qty">
    <UButton
      icon="i-lucide-minus"
      variant="soft"
      color="neutral"
      :disabled="disabled || decreased === null || decreased === value"
      aria-label="Уменьшить"
      @click="dec"
    />

    <span class="qty__value">
      <slot>{{ label }}</slot>
    </span>

    <UButton
      icon="i-lucide-plus"
      variant="soft"
      color="neutral"
      aria-label="Увеличить"
      :disabled="disabled || removeOnly || increased === null"
      @click="inc"
    />
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";
import { qtyText } from "~/utils/qty";
import { manualQuantity } from "~/utils/assembly";
import { previousCartQty, validCartQty } from '~/utils/cart';

const { product, removable, disabled, removeOnly } = defineProps<{
  product: ProductListItem;
  removable?: boolean;
  disabled?: boolean;
  removeOnly?: boolean;
}>();

const value = defineModel<number>({ required: true });
const decreased = computed(() => removable
  ? removeOnly ? 0 : previousCartQty(value.value, product) ?? 0
  : manualQuantity(value.value, product, -1));
const increased = computed(() => {
  const next = manualQuantity(value.value, product, 1);
  return next !== null && validCartQty(next, product) ? next : null;
});

function dec() {
  if (!disabled && decreased.value !== null) value.value = decreased.value;
}

function inc() {
  if (!disabled && !removeOnly && increased.value !== null) value.value = increased.value;
}

const label = computed(() => qtyText(product.unit, value.value, product));
</script>

<style scoped>
.qty {
  display: flex;
  min-width: 0;
  width: fit-content;
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
  min-width: 0;
  flex: 0 1 3.5rem;
  text-align: center;
  font-weight: 600;
  overflow-wrap: anywhere;
}

@media (min-width: 40rem) {
  .qty {
    gap: 0.75rem;
  }

  .qty__value {
    flex-basis: 5rem;
  }
}
</style>
