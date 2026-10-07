<template>
  <p v-if="data" class="text-sm text-muted" role="status">
    <template v-if="data.isOpen">Рынок открыт до {{ data.closeTime }}</template>
    <template v-else>Рынок закрыт<span v-if="data.nextOpenAt"> · откроемся {{ nextOpen }}</span>. Предзаказы принимаются.</template>
  </p>
</template>
<script setup lang="ts">
import type { ShopStatus } from '~/types/admin-ops';
const { data } = await useApi<ShopStatus>('/shop/status');
const nextOpen = computed(() => data.value?.nextOpenAt
  ? new Date(data.value.nextOpenAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
  : '');
</script>
