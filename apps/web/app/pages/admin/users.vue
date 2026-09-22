<template>
  <div class="space-y-5">
    <h2 class="text-2xl font-semibold">Пользователи</h2>
    <form class="grid min-w-0 gap-3 items-end sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]" @submit.prevent="apply">
      <UFormField label="Телефон или имя"
        ><UInput v-model="search" maxlength="160"
      /></UFormField>
      <UFormField label="Роль"
        ><USelect
          v-model="role"
          :items="[
            { label: 'Все', value: 'all' },
            { label: 'Пользователь', value: 'USER' },
            { label: 'Продавец', value: 'SELLER' },
            { label: 'Администратор', value: 'ADMIN' },
          ]"
      /></UFormField>
      <UButton type="submit" :loading="pending">Найти</UButton>
    </form>
    <p v-if="pending">Загрузка…</p>
    <UAlert v-else-if="error" color="error" :title="apiError(error)" />
    <p v-else-if="!data?.items.length">Пользователи не найдены</p>
    <div v-else class="overflow-x-auto border border-default rounded-lg">
      <table class="min-w-[1100px] w-full text-sm">
        <thead class="text-left bg-elevated">
          <tr>
            <th class="p-3">ID / Имя</th>
            <th>Телефон</th>
            <th>Роль</th>
            <th>Верифицирован</th>
            <th>Заказов</th>
            <th>Потрачено</th>
            <th>Регистрация</th>
            <th>Обновлён</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="user in data.items"
            :key="user.id"
            class="border-t border-default"
          >
            <td class="p-3">
              <button
                class="min-h-(--touch-target) text-primary text-left"
                @click="
                  detailId = user.id;
                  detailOpen = true;
                "
              >
                #{{ user.id }}<br >{{ user.name ?? "Без имени" }}
              </button>
            </td>
            <td class="pr-3">{{ user.phone ?? "—" }}</td>
            <td class="pr-3">
              <UBadge :color="user.role === 'ADMIN' ? 'primary' : 'neutral'">{{
                roles[user.role]
              }}</UBadge>
            </td>
            <td class="pr-3">{{ date(user.verifiedAt) }}</td>
            <td>{{ user.orders }}</td>
            <td class="pr-3">
              {{ money(user.spent)
              }}<span v-if="user.unknownTotals" class="block text-muted"
                >+ {{ user.unknownTotals }} без итога</span
              >
            </td>
            <td class="pr-3">{{ date(user.createdAt) }}</td>
            <td class="pr-3">{{ date(user.updatedAt) }}</td>
            <td class="p-3">
              <UButton
                v-if="!user.protected"
                size="xs"
                variant="outline"
                :disabled="busy"
                @click="
                  selected = user;
                  confirm = true;
                "
                >{{
                  user.role === "USER"
                    ? "Сделать продавцом"
                    : "Убрать права продавца"
                }}</UButton
              ><span v-else class="text-muted">Защищён</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="data" class="flex flex-wrap items-center gap-3">
      <UButton
        :disabled="query.page <= 1 || pending"
        variant="outline"
        @click="query.page--"
        >Назад</UButton
      ><span
        >{{ query.page }} / {{ Math.max(1, data.pages) }} · Всего
        {{ data.total }}</span
      ><UButton
        :disabled="query.page >= data.pages || pending"
        variant="outline"
        @click="query.page++"
        >Далее</UButton
      >
    </div>
    <AdminConfirm
      v-model:open="confirm"
      :title="
        selected?.role === 'USER'
          ? 'Сделать пользователя продавцом?'
          : 'Убрать права продавца?'
      "
      :description="selected?.phone ?? selected?.name ?? undefined"
      :busy="busy"
      @confirm="changeRole"
    />
    <AdminUserDetail
      v-if="detailId && detailOpen"
      :id="detailId"
      v-model:open="detailOpen"
    />
  </div>
</template>

<script setup lang="ts">
import type { AdminUser, AdminPage } from "~/types/admin";
definePageMeta({ middleware: "admin", layout: "admin" });
const search = ref("");
const role = ref("all");
const query = reactive({
  page: 1,
  limit: 20,
  search: "",
  role: undefined as string | undefined,
});
const { data, pending, error, refresh } = await useApi<AdminPage<AdminUser>>(
  "/admin/users",
  { query },
);
function apply() {
  Object.assign(query, {
    page: 1,
    search: search.value,
    role: role.value === "all" ? undefined : role.value,
  });
}
const roles = {
  USER: "Пользователь",
  SELLER: "Продавец",
  ADMIN: "Администратор",
};
function date(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" })
    : "—";
}
const api = useApiClient();
const toast = useToast();
const selected = ref<AdminUser>();
const busy = ref(false);
const confirm = ref(false);
const detailId = ref(0);
const detailOpen = ref(false);
async function changeRole() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  const role = selected.value.role === "USER" ? "SELLER" : "USER";
  try {
    await api(`/admin/users/${selected.value.id}/role`, {
      method: "PATCH",
      body: { role },
    });
    confirm.value = false;
    toast.add({
      title:
        role === "SELLER"
          ? "Пользователь назначен продавцом"
          : "Права продавца удалены",
      color: "success",
    });
    await refresh();
  } catch (value) {
    toast.add({ title: apiError(value), color: "error" });
  } finally {
    busy.value = false;
  }
}
</script>
