<template>
  <span
    v-if="badge"
    class="attention-badge"
    :class="`attention-badge--${variant}`"
    aria-hidden="true"
    >{{ badge }}</span
  >
</template>

<script setup lang="ts">
import { newOrdersBadge } from "~/utils/new-orders";
const props = withDefaults(
  defineProps<{ count: number; variant?: "info" | "success" }>(),
  { variant: "info" },
);
const badge = computed(() => newOrdersBadge(props.count));
</script>

<style scoped>
.attention-badge {
  position: absolute;
  top: 0;
  right: 0;
  display: grid;
  place-items: center;
  min-width: 1.125rem;
  height: 1.125rem;
  padding-inline: 0.2rem;
  border-radius: 999px;
  color: var(--color-white);
  font-size: 0.625rem;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}
.attention-badge--success {
  background: var(--ui-color-success-600);
}
.attention-badge--info {
  top: auto;
  bottom: 0;
  background: var(--ui-color-info-600);
}
</style>
