<template>
  <div class="messages">
    <UButton
      :to="to"
      icon="i-lucide-message-circle"
      color="neutral"
      variant="ghost"
      class="messages__button"
      :aria-label="count ? `Сообщения, ${count} непрочитанных` : 'Сообщения'"
    />
    <span v-if="count" class="messages__count" aria-hidden="true">{{
      count > 99 ? "99+" : count
    }}</span>
  </div>
</template>
<script setup lang="ts">
defineProps<{ count: number; to: string }>();
</script>
<style scoped>
.messages {
  position: relative;
  flex-shrink: 0;
}
.messages__button {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
}
.messages__count {
  position: absolute;
  top: 0;
  right: 0;
  pointer-events: none;
  border-radius: 1rem;
  padding: 0 0.25rem;
  min-width: 1rem;
  text-align: center;
  font-size: 0.65rem;
  color: var(--ui-bg);
  background: var(--ui-primary);
}
</style>
