<template>
  <div class="space-y-5">
    <h2 class="text-2xl font-semibold">Пользователи</h2>
    <form
      class="grid min-w-0 gap-3 items-end sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
      @submit.prevent="apply"
    >
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
            { label: 'Владелец точки', value: 'POINT_OWNER' },
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
              <UBadge
                v-if="user.ownedPoints.length"
                color="success"
                class="mt-1"
                >Владелец точки</UBadge
              >
              <p
                v-for="point in user.ownedPoints"
                :key="point.marketPointId"
                class="text-xs text-muted"
              >
                {{ point.marketPoint.name }}
              </p>
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
                v-if="
                  !user.protected &&
                  permissions?.primaryAdmin
                "
                size="xs"
                variant="outline"
                :disabled="busy"
                @click="editRole(user)"
                >Права доступа</UButton
              ><span v-else class="text-muted">{{
                user.protected
                  ? "Основной администратор"
                  : "Права задаёт основной администратор"
              }}</span>
              <UButton
                v-if="permissions?.primaryAdmin"
                class="mt-2"
                size="xs"
                variant="soft"
                :disabled="busy"
                @click="editPoints(user)"
                >Точки владельца</UButton
              >
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
    <UModal
      v-model:open="confirm"
      title="Права доступа"
      :description="
        selected?.phone ?? selected?.name ?? 'Выберите роль пользователя'
      "
    >
      <template #body>
        <div class="space-y-4">
          <UFormField label="Роль"
            ><USelect v-model="nextRole" :items="roleOptions" :disabled="busy"
          /></UFormField>
          <template v-if="nextRole === 'ADMIN'">
            <UAlert
              title="Полный доступ к магазину"
              description="Администратор сможет управлять товарами, заказами, оплатами, настройками и работать в Telegram. Назначать других администраторов сможет только основной админ. О действиях нового администратора основной админ получит уведомления."
            />
            <UFormField
              :label="
                selected?.role === 'ADMIN'
                  ? 'Новый пароль администратора'
                  : 'Отдельный пароль администратора'
              "
              help="От 12 до 128 символов. Передайте пароль этому пользователю лично."
            >
              <UInput
                v-model="adminPassword"
                type="password"
                autocomplete="new-password"
                :maxlength="128"
                :disabled="busy"
                class="w-full"
              />
            </UFormField>
            <p class="text-sm text-muted">
              Вход: /admin/login, номер пользователя и этот пароль. Для бота
              сотрудников пользователь подключает Telegram в своём кабинете.
            </p>
          </template>
          <p class="text-sm text-muted">
            После изменения прав или пароля пользователю потребуется войти
            заново.
          </p>
        </div>
      </template>
      <template #footer>
        <UButton
          :loading="busy"
          :disabled="nextRole === 'ADMIN' && adminPassword.length < 12"
          @click="changeRole"
          >Сохранить права</UButton
        >
        <UButton
          variant="ghost"
          color="neutral"
          :disabled="busy"
          @click="
            confirm = false;
            adminPassword = '';
          "
          >Отмена</UButton
        >
      </template>
    </UModal>
    <UModal
      v-model:open="pointsOpen"
      title="Права владельца точки"
      :description="
        ownerUser?.phone ??
        ownerUser?.name ??
        'Выберите торговые точки пользователя'
      "
    >
      <template #body>
        <p class="mb-4 text-sm text-muted">
          Владелец получает доступ к заказам и редактирует только товары
          назначенных точек. Права продавца задаются отдельно. После сохранения
          пользователю нужно войти заново.
        </p>
        <div class="space-y-3">
          <UCheckbox
            v-for="point in pointOptions"
            :key="point.id"
            :model-value="pointIds.includes(point.id)"
            :label="`${point.name} · ${point.floor} этаж`"
            :disabled="busy"
            @update:model-value="togglePoint(point.id, $event === true)"
          />
        </div>
        <p v-if="!pointOptions.length">
          Сначала добавьте торговую точку в разделе «Карта рынка».
        </p>
      </template>
      <template #footer>
        <UButton :loading="busy" @click="savePoints">Сохранить права</UButton>
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="pointsOpen = false"
          >Отмена</UButton
        >
      </template>
    </UModal>
    <AdminUserDetail
      v-if="detailId && detailOpen"
      :id="detailId"
      v-model:open="detailOpen"
    />
  </div>
</template>

<script setup lang="ts">
import type { MarketPoint } from "~/types/market-map";
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
const { data: permissions } = await useApi<{ primaryAdmin: boolean }>(
  "/admin/users/permissions",
);
const toast = useToast();
const selected = ref<AdminUser>();
const nextRole = ref<AdminUser["role"]>("USER");
const adminPassword = ref("");
const roleOptions = computed(() => [
  { label: "Пользователь", value: "USER" },
  { label: "Продавец", value: "SELLER" },
  ...(permissions.value?.primaryAdmin
    ? [{ label: "Администратор", value: "ADMIN" }]
    : []),
]);
function editRole(user: AdminUser) {
  selected.value = user;
  nextRole.value = user.role;
  adminPassword.value = "";
  confirm.value = true;
}
const busy = ref(false);
const confirm = ref(false);
watch(confirm, (open) => {
  if (!open) adminPassword.value = "";
});
const ownerUser = ref<AdminUser>();
const pointsOpen = ref(false),
  pointIds = ref<number[]>([]);
const { data: allPoints } = await useApi<MarketPoint[]>(
  "/admin/market-map/points",
);
const pointOptions = computed(() =>
  (allPoints.value ?? []).filter(
    (point) => !["ENTRY", "SERVICE"].includes(point.kind),
  ),
);
function editPoints(user: AdminUser) {
  ownerUser.value = user;
  pointIds.value = user.ownedPoints.map((point) => point.marketPointId);
  pointsOpen.value = true;
}
function togglePoint(id: number, checked: boolean) {
  pointIds.value = pointIds.value.filter((value) => value !== id);
  if (checked) pointIds.value.push(id);
}
async function savePoints() {
  if (!ownerUser.value || busy.value) return;
  busy.value = true;
  try {
    await api(`/admin/users/${ownerUser.value.id}/points`, {
      method: "PATCH",
      body: { pointIds: pointIds.value },
    });
    pointsOpen.value = false;
    await refresh();
    toast.add({ title: "Права владельца сохранены", color: "success" });
  } catch (value) {
    toast.add({ title: apiError(value), color: "error" });
  } finally {
    busy.value = false;
  }
}
const detailId = ref(0);
const detailOpen = ref(false);
async function changeRole() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  const role = nextRole.value;
  try {
    await api(`/admin/users/${selected.value.id}/role`, {
      method: "PATCH",
      body: {
        role,
        ...(role === "ADMIN" ? { password: adminPassword.value } : {}),
      },
    });
    confirm.value = false;
    adminPassword.value = "";
    toast.add({
      title:
        role === "ADMIN"
          ? "Права администратора и пароль сохранены"
          : role === "SELLER"
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
