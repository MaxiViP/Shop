<template>
  <UBadge
    :color="meta.color"
    variant="soft"
  >
    {{ meta.label }}
  </UBadge>
</template>

<script setup lang="ts">
import type { OrderStatus } from '~/types/order'
import { orderStatus } from '~/utils/order'

const { status } = defineProps<{
  status: OrderStatus
}>()

const meta = computed(
  () => orderStatus[status],
)
</script>
