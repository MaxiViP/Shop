<template>
  <strong class="price">
    {{ money(product.price) }} / {{ unit }}
  </strong>
</template>

<script setup lang="ts">
import type { Product } from '~/types/product'
import { money } from '~/utils/money'

const { product } = defineProps<{
  product: Product
}>()

const unit = computed(() => {
  if (product.unit === 'GRAM') {
    return product.priceQty === 1000
      ? 'кг'
      : `${product.priceQty} г`
  }

  return {
    PIECE: 'шт.',
    BUNCH: 'пучок',
    PACK: 'уп.',
  }[product.unit]
})
</script>

<style scoped>
.price {
  font-size: 1.125rem;
}
</style>
