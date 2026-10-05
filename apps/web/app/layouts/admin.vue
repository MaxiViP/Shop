<template>
  <UContainer class="py-6 space-y-6">
    <header
      class="flex flex-wrap items-center gap-3 border-b border-default pb-4"
    >
      <h1 class="text-xl font-semibold mr-auto">Админка</h1>
      <AppThemeControl />
      <AppOrdersAction :action="orders" />
      <UButton to="/" variant="ghost" color="neutral">На сайт</UButton>
      <UButton :loading="busy" variant="outline" color="neutral" @click="logout"
        >Выйти</UButton
      >
      <nav aria-label="Админка" class="flex flex-wrap gap-1 w-full border-t border-default pt-3">
        <UButton
          v-for="item in navigation" :key="item.to" :to="item.to"
          :icon="item.icon" size="sm"
          :variant="route.path === item.to || (item.to !== '/admin' && route.path.startsWith(`${item.to}/`)) ? 'solid' : 'ghost'">
          {{ item.label }}
        </UButton>
      </nav>
    </header>
    <slot />
  </UContainer>
</template>

<script setup lang="ts">
import { useAuthStore } from "~/stores/auth";
const route = useRoute();
const navigation = [
  { to: '/admin', label: 'Обзор', icon: 'i-lucide-layout-dashboard' },
  { to: '/admin/orders', label: 'Заказы', icon: 'i-lucide-clipboard-list' },
  { to: '/admin/products', label: 'Товары и категории', icon: 'i-lucide-package' },
  { to: '/admin/finance', label: 'Отчёты', icon: 'i-lucide-chart-no-axes-combined' },
  { to: '/admin/payouts', label: 'Выплаты', icon: 'i-lucide-wallet' },
  { to: '/admin/users', label: 'Пользователи', icon: 'i-lucide-users' },
  { to: '/admin/schedule', label: 'Режим работы', icon: 'i-lucide-clock' },
  { to: '/admin/queue', label: 'Очередь и нагрузка', icon: 'i-lucide-gauge' },
  { to: '/admin/settings', label: 'Настройки', icon: 'i-lucide-settings' },
];
const auth = useAuthStore();
const orders = useOrdersAction();
const api = useApiClient();
const toast = useToast();
const busy = ref(false);
async function logout() {
  if (busy.value) return;
  busy.value = true;
  try {
    await api("/auth/logout", { method: "POST" });
    auth.clear();
    await navigateTo("/admin/login");
  } catch (error) {
    toast.add({ title: apiError(error), color: "error" });
  } finally {
    busy.value = false;
  }
}
</script>
