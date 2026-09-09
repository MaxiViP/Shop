<template>
  <div class="new-orders">
    <UButton
      to="/staff/orders?tab=new"
      icon="i-lucide-clipboard-list"
      color="neutral"
      variant="ghost"
      class="new-orders__button"
      :aria-label="count ? `Новые заказы, ${count}` : 'Новые заказы'"
      @click="revision++"
    />
    <span v-if="badge" class="new-orders__badge" aria-hidden="true">{{
      badge
    }}</span>
  </div>
</template>
<script setup lang="ts">
import { newOrdersBadge } from "~/utils/new-orders";
const props = defineProps<{ count: number }>();
const revision = useNewOrdersRevision();
const badge = computed(() => newOrdersBadge(props.count));
</script>
<style scoped>
.new-orders {
  position: relative;
  flex-shrink: 0;
}
.new-orders__button {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
}
.new-orders__badge {
  position: absolute;
  top: 0;
  right: 0;
  pointer-events: none;
  border-radius: 1rem;
  padding: 0 0.25rem;
  min-width: 1rem;
  font-size: 0.65rem;
  text-align: center;
  color: var(--ui-bg);
  background: var(--ui-primary);
}
</style>
