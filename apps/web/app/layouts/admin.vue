<template>
  <UContainer class="py-6 space-y-6">
    <header
      class="flex flex-wrap items-center gap-3 border-b border-default pb-4"
    >
      <h1 class="text-xl font-semibold mr-auto">Админка</h1>
      <UButton to="/" variant="ghost" color="neutral">На сайт</UButton>
      <UButton :loading="busy" variant="outline" color="neutral" @click="logout"
        >Выйти</UButton
      >
      <nav aria-label="Админка" class="flex gap-2 w-full">
        <UButton
          to="/admin/products"
          :variant="
            route.path.startsWith('/admin/products') ? 'solid' : 'ghost'
          "
          >Товары</UButton
        >
        <UButton
          to="/admin/users"
          :variant="route.path === '/admin/users' ? 'solid' : 'ghost'"
          >Пользователи</UButton
        >
      </nav>
    </header>
    <slot />
  </UContainer>
</template>

<script setup lang="ts">
import { useAuthStore } from "~/stores/auth";
const route = useRoute();
const auth = useAuthStore();
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
