<template>
  <UContainer class="py-12">
    <UCard class="max-w-md mx-auto">
      <template #header
        ><h1 class="text-xl font-semibold">Вход в админку</h1></template
      >
      <form class="space-y-4" @submit.prevent="login">
        <UFormField label="Телефон" required
          ><AppTextInput
            v-model="phone"
            format="phone"
            type="tel"
            autocomplete="username"
            required
            class="w-full"
            :disabled="busy"
        /></UFormField>
        <UFormField label="Пароль" required
          ><UInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            class="w-full"
            :disabled="busy"
        /></UFormField>
        <UAlert v-if="error" color="error" :title="error" />
        <UButton type="submit" :loading="busy" block>Войти</UButton>
      </form>
    </UCard>
  </UContainer>
</template>

<script setup lang="ts">
definePageMeta({ middleware: "admin" });
useHead({ title: "Вход в админку" });
const adminLogin = useAdminLogin();
const phone = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
async function login() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await adminLogin(phone.value, password.value);
    password.value = "";
    await navigateTo("/admin/products");
  } catch (value) {
    error.value = apiError(value);
  } finally {
    busy.value = false;
  }
}
</script>
