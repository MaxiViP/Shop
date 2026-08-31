<script setup lang="ts">
import type { Product } from '~/types/product'

const { product } = defineProps<{
  product: Product
}>()

const value = defineModel<number>({ required: true })

function dec() {
  value.value = Math.max(product.min, value.value - product.step)
}

function inc() {
  value.value += product.step
}

const label = computed(() => {
  if (product.unit !== 'GRAM') {
    return `${value.value} ${
      {
        PIECE: 'шт.',
        BUNCH: 'пуч.',
        PACK: 'уп.',
      }[product.unit]
    }`
  }

  if (value.value >= 1000) {
    return `${(value.value / 1000)
      .toLocaleString('ru-RU', {
        maximumFractionDigits: 2,
      })} кг`
  }

  return `${value.value} г`
})
</script>

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

<style scoped>
.qty {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.qty__value {
  min-width: 80px;
  text-align: center;
  font-weight: 600;
}
</style>
