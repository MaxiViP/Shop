<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="mr-auto text-2xl font-semibold">Изменения администраторов</h2>
      <UButton variant="outline" :loading="testing" @click="testDelivery"
        >Проверить уведомления</UButton
      >
      <UButton variant="outline" :loading="pending" @click="refresh()"
        >Обновить</UButton
      >
    </div>
    <p class="text-sm text-muted">
      Здесь сохраняются действия других администраторов на сайте и в Telegram.
      Ваши собственные изменения не вызывают уведомлений.
    </p>
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <UAlert
      v-if="data && !data.deliveryReady"
      color="warning"
      title="Подключите Telegram для уведомлений"
      description="В кабинете сотрудника получите код подключения и отправьте его боту сотрудников. Журнал сохраняется и до подключения бота."
    />
    <p v-if="data && !data.items.length">
      Другие администраторы пока не вносили изменений.
    </p>
    <UCard v-for="event in data?.items ?? []" :key="event.id">
      <div class="flex flex-wrap items-center gap-2">
        <strong class="mr-auto"
          >{{ operations[event.operation] ?? event.operation }}:
          {{ entities[event.entity] ?? event.entity }} #{{
            event.entityId
          }}</strong
        >
        <UBadge
          :color="
            event.status === 'SENT'
              ? 'success'
              : ['UNKNOWN', 'FAILED'].includes(event.status)
                ? 'warning'
                : 'neutral'
          "
          >{{ statuses[event.status] ?? event.status }}</UBadge
        >
      </div>
      <p class="mt-2 text-sm text-muted">
        {{ event.actorName }} ·
        {{ event.source === "TELEGRAM" ? "Telegram" : "Админка сайта" }} ·
        {{ date(event.createdAt) }} · Запись №{{ event.id }}
      </p>
      <dl class="mt-4 space-y-2 text-sm">
        <div
          v-for="key in changedKeys(event)"
          :key="key"
          class="grid gap-1 sm:grid-cols-[minmax(140px,1fr)_3fr]"
        >
          <dt class="font-medium">{{ fields[key] ?? key }}</dt>
          <dd class="min-w-0 break-words">
            {{ value(event.beforeValue?.[key], key) }} →
            {{ value(event.afterValue?.[key], key) }}
          </dd>
        </div>
      </dl>
      <UButton
        v-if="['UNKNOWN', 'FAILED'].includes(event.status)"
        class="mt-4"
        size="sm"
        variant="outline"
        @click="
          retryId = event.id;
          retryOpen = true;
        "
        >Повторить уведомление</UButton
      >
    </UCard>
    <div v-if="data" class="flex items-center gap-3">
      <UButton
        :disabled="page <= 1 || pending"
        variant="outline"
        @click="page--"
        >Назад</UButton
      >
      <span
        >{{ page }} / {{ Math.max(1, data.pages) }} · Всего
        {{ data.total }}</span
      >
      <UButton
        :disabled="page >= data.pages || pending"
        variant="outline"
        @click="page++"
        >Далее</UButton
      >
    </div>
    <AdminConfirm
      v-model:open="retryOpen"
      title="Повторить уведомление?"
      description="Если Telegram уже доставил предыдущее сообщение, повтор может создать дубликат. Повторятся уведомления о связанных изменениях этого действия."
      :busy="busy"
      @confirm="retry"
    />
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: "admin", layout: "admin" });
type Event = {
  id: number;
  actorName: string;
  source: string;
  entity: string;
  entityId: string;
  operation: string;
  status: string;
  createdAt: string;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
};
const page = ref(1);
const { data, error, pending, refresh } = await useApi<{
  items: Event[];
  total: number;
  pages: number;
  deliveryReady: boolean;
}>("/admin/activity", { query: { page } });
const operations: Record<string, string> = {
  INSERT: "Создано",
  UPDATE: "Изменено",
  DELETE: "Удалено",
};
const statuses: Record<string, string> = {
  PENDING: "Ожидает отправки",
  SENDING: "Отправляется",
  SENT: "Доставлено в Telegram",
  UNKNOWN: "Доставка не подтверждена",
  FAILED: "Не удалось доставить",
};
const entities: Record<string, string> = {
  User: "Пользователь",
  MarketPointOwner: "Права на точку",
  Product: "Товар",
  ProductImage: "Фото товара",
  Category: "Категория",
  MarketPoint: "Торговая точка",
  MarketLayout: "Карта рынка",
  SeasonTemplate: "Сезон",
  HomeSlide: "Слайд",
  ShopSettings: "Настройки",
  ShopHours: "Режим работы",
  ShopHoursException: "Исключение расписания",
  PromoCode: "Промокод",
  PartnerPayout: "Выплата",
  Order: "Заказ",
  OrderItem: "Позиция заказа",
  OrderPayment: "Оплата",
  OrderExtra: "Доплата",
  OrderCancellation: "Отмена",
  OrderIssue: "Согласование",
  OrderItemPriceChange: "Цена позиции",
  Delivery: "Доставка",
  DeliveryAttempt: "Заявка доставки",
  OrderChatMessage: "Сообщение",
  OrderChatImageRevision: "Фото по заказу",
};
const fields: Record<string, string> = {
  id: "Номер",
  name: "Название",
  phone: "Телефон",
  role: "Роль",
  price: "Цена",
  active: "Активен",
  status: "Статус",
  serviceMarkupPercent: "Наценка, %",
  quantity: "Количество",
  qty: "Количество",
  actualQty: "Собрано",
  amount: "Сумма",
  total: "Итого",
  finalTotal: "Итого после сборки",
  title: "Заголовок",
  text: "Текст",
  description: "Описание",
  adminPasswordChanged: "Пароль изменён",
  categoryId: "Категория",
  marketPointId: "Торговая точка",
  sort: "Порядок",
  published: "Опубликован",
  visible: "Видимость",
  min: "Минимальное количество",
  step: "Шаг",
  priceQty: "Количество для цены",
  unit: "Единица",
  userId: "Пользователь",
  orderId: "Заказ",
  comment: "Комментарий",
  createdAt: "Создано",
  updatedAt: "Обновлено",
};
function date(input: string) {
  return new Date(input).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}
function changedKeys(event: Event) {
  return [
    ...new Set([
      ...Object.keys(event.beforeValue ?? {}),
      ...Object.keys(event.afterValue ?? {}),
    ]),
  ];
}
function value(input: unknown, key: string): string {
  if (input === null || input === undefined) return "—";
  if (typeof input === "boolean") return input ? "Да" : "Нет";
  if (
    typeof input === "number" &&
    [
      "price",
      "amount",
      "total",
      "finalTotal",
      "basePrice",
      "actualTotal",
      "subtotal",
      "finalSubtotal",
    ].includes(key)
  )
    return money(input);
  if (key === "role" && typeof input === "string")
    return (
      (
        {
          USER: "Пользователь",
          SELLER: "Продавец",
          ADMIN: "Администратор",
        } as Record<string, string>
      )[input] ?? input
    );
  return typeof input === "string" ? input : JSON.stringify(input);
}
const retryId = ref<number>(),
  retryOpen = ref(false),
  busy = ref(false),
  api = useApiClient(),
  toast = useToast();
const testing = ref(false);
async function testDelivery() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await api<{ status: string }>("/admin/activity/test", {
      method: "POST",
    });
    toast.add({
      title:
        result.status === "sent"
          ? "Проверочное сообщение отправлено в ваш Telegram"
          : "Доставка сообщения не подтверждена",
      color: result.status === "sent" ? "success" : "warning",
    });
  } catch (e) {
    toast.add({ title: apiError(e), color: "error" });
  } finally {
    testing.value = false;
  }
}
async function retry() {
  if (!retryId.value || busy.value) return;
  busy.value = true;
  try {
    await api(`/admin/activity/${retryId.value}/retry`, { method: "POST" });
    retryOpen.value = false;
    await refresh();
  } catch (e) {
    toast.add({ title: apiError(e), color: "error" });
  } finally {
    busy.value = false;
  }
}
</script>
