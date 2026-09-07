<template>
  <UBadge
    class="status"
    :color="meta.color"
    variant="soft"
  >
    {{ meta.label }}
  </UBadge>
</template>

<script setup lang="ts">
import type { OrderStatus, OrderType } from '~/types/order'
import { orderMeta } from '~/utils/order'

const { status, type = 'DELIVERY' } = defineProps<{
  status: OrderStatus
  type?: OrderType
}>()

const meta = computed(
  () => orderMeta(status, type),
)
</script>

<style scoped>
.status {
  max-width: 100%;
  white-space: normal;
  text-align: center;
  overflow-wrap: anywhere;
}
</style>
