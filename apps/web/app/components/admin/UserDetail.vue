<template>
  <UModal
    v-model:open="open"
    title="Пользователь"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <p v-if="pending">Загрузка…</p>
      <UAlert v-else-if="error" color="error" :title="apiError(error)" />
      <div v-else-if="user" class="space-y-5">
        <dl class="grid grid-cols-2 gap-2 text-sm">
          <dt>ID</dt>
          <dd>{{ user.id }}</dd>
          <dt>Имя</dt>
          <dd>{{ user.name ?? "—" }}</dd>
          <dt>Телефон</dt>
          <dd>{{ user.phone ?? "—" }}</dd>
          <dt>Роль</dt>
          <dd>{{ user.role }}</dd>
          <dt>Верифицирован</dt>
          <dd>{{ date(user.verifiedAt) }}</dd>
          <dt>Регистрация</dt>
          <dd>{{ date(user.createdAt) }}</dd>
          <dt>Обновлён</dt>
          <dd>{{ date(user.updatedAt) }}</dd>
        </dl>
        <p>
          Заказов: {{ user.stats.orders }} · Завершено:
          {{ user.stats.completed }} · Потрачено: {{ money(user.stats.spent) }}
        </p>
        <p v-if="user.stats.unknownTotals" class="text-muted">
          Сумма неизвестна для {{ user.stats.unknownTotals }} завершённых
          заказов.
        </p>
        <h3 class="font-semibold">Адреса</h3>
        <p v-if="!user.addresses.length">Адресов нет</p>
        <div
          v-for="address in user.addresses"
          :key="address.id"
          class="border border-default rounded p-3 text-sm"
        >
          <strong
            >{{ address.label
            }}{{ address.isDefault ? " · Основной" : "" }}</strong
          >
          <p>
            {{ address.city }}, {{ address.street }}, {{ address.house
            }}{{ address.flat ? `, кв. ${address.flat}` : "" }}
          </p>
          <p>
            Подъезд: {{ address.entrance ?? "—" }} · Этаж:
            {{ address.floor ?? "—" }} · Домофон: {{ address.intercom ?? "—" }}
          </p>
          <p v-if="address.comment">{{ address.comment }}</p>
        </div>
        <h3 class="font-semibold">Последние заказы</h3>
        <p v-if="!user.orders.length">Заказов нет</p>
        <div
          v-for="order in user.orders"
          :key="order.publicId"
          class="border border-default rounded p-3 text-sm break-words"
        >
          <span>{{ order.publicId }}</span>
          <p>
            {{ order.status }} · {{ order.type }} ·
            {{ knownMoney(order.finalTotal ?? order.total) }}
          </p>
          <p>{{ date(order.createdAt) }}</p>
        </div>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { AdminUserDetail } from "~/types/admin";
const props = defineProps<{ id: number }>();
const open = defineModel<boolean>("open", { required: true });
const {
  data: user,
  pending,
  error,
} = await useApi<AdminUserDetail>(() => `/admin/users/${props.id}`);
function date(value: string | null) {
  return value
    ? new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })
    : "—";
}
</script>
