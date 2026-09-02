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
import type { OrderStatus } from '~/types/order'
import { orderStatus } from '~/utils/order'

const { status } = defineProps<{
  status: OrderStatus
}>()

const meta = computed(
  () => orderStatus[status],
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
