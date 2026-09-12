<template>
  <div class="orders-action">
    <UButton
      :to="action.to"
      :icon="
        action.to.startsWith('/staff/')
          ? 'i-lucide-clipboard-list'
          : 'i-lucide-package'
      "
      color="neutral"
      variant="ghost"
      class="orders-action__button"
      :aria-label="action.label"
      :title="action.label"
    >
      <span class="orders-action__label">{{ action.name }}</span>
    </UButton>
    <AppAttentionBadge :count="action.newOrdersCount" variant="success" />
    <AppAttentionBadge :count="action.unreadMessagesCount" variant="info" />
  </div>
</template>

<script setup lang="ts">
import type { ordersAction } from "~/utils/orders-action";
defineProps<{ action: ReturnType<typeof ordersAction> }>();
</script>

<style scoped>
.orders-action {
  position: relative;
  flex-shrink: 0;
}
.orders-action__button {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
}
.orders-action__label {
  display: none;
}
@media (min-width: 64rem) {
  .orders-action__label {
    display: inline;
  }
}
</style>
