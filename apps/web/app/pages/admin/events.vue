<template>
  <div class="events">
    <header class="events__header">
      <div>
        <p class="events__eyebrow">KORZINAMARKET · РАБОТА МАГАЗИНА</p>
        <h2 class="events__title">Центр событий</h2>
        <p class="events__subtitle">
          Заказы, команда и изменения — в одной ленте
        </p>
      </div>
      <div class="events__connection" role="status">
        <span
          class="events__dot"
          :class="{ 'events__dot--live': connection === 'live' }"
        />
        {{
          connection === "live"
            ? "Обновляется онлайн"
            : connection === "denied"
              ? "Доступ закрыт"
              : "Переподключение…"
        }}
      </div>
    </header>
    <div class="events__workspace">
      <aside
        class="events__filters"
        :class="{ 'events__filters--open': filtersOpen }"
        aria-label="Фильтры событий"
      >
        <div class="events__filter-heading">
          <strong>Фильтры</strong
          ><UButton
            class="events__filter-toggle"
            size="xs"
            variant="ghost"
            :aria-expanded="filtersOpen"
            @click="filtersOpen = !filtersOpen"
            >{{ filtersOpen ? "Скрыть фильтры" : "Показать фильтры" }}</UButton
          ><UButton size="xs" variant="ghost" @click="resetFilters"
            >Сбросить</UButton
          >
        </div>
        <form class="events__form" @submit.prevent="apply">
          <UFormField label="Поиск по событиям"
            ><UInput
              v-model="form.q"
              icon="i-lucide-search"
              placeholder="Название, изменение…"
              :maxlength="160"
              class="w-full"
          /></UFormField>
          <UFormField label="Категория"
            ><USelect
              v-model="form.category"
              :items="categoryOptions"
              class="w-full"
          /></UFormField>
          <UFormField label="Сотрудник"
            ><USelect
              v-model="form.actorId"
              :items="actorOptions"
              class="w-full"
          /></UFormField>
          <div class="events__date-range">
            <UFormField label="С даты (МСК)"
              ><UInput v-model="form.from" type="date" class="w-full"
            /></UFormField>
            <UFormField label="По дату"
              ><UInput v-model="form.to" type="date" class="w-full"
            /></UFormField>
          </div>
          <UFormField label="Номер заказа"
            ><UInput
              v-model="form.orderId"
              type="number"
              :min="1"
              placeholder="Например, 1000"
              class="w-full"
          /></UFormField>
          <UButton type="submit" block :loading="pending"
            >Применить фильтры</UButton
          >
        </form>
        <p class="events__privacy">
          <UIcon name="i-lucide-shield-check" />{{
            data?.primary
              ? "Вы видите все события, включая закрытые изменения прав."
              : "Общая рабочая лента. Закрытые события доступны владельцу."
          }}
        </p>
        <UButton
          v-if="data?.primary"
          to="/admin/activity"
          variant="link"
          size="sm"
          >Доставка уведомлений владельцу</UButton
        >
      </aside>
      <section
        class="events__conversation"
        aria-label="Лента событий"
        :aria-busy="pending"
      >
        <div class="events__toolbar">
          <div>
            <strong>Лента магазина</strong
            ><span class="events__total">{{ data?.total ?? 0 }} событий</span>
          </div>
          <div class="events__group-control" aria-label="Группировка">
            <UButton
              size="xs"
              :variant="groupBy === 'operation' ? 'soft' : 'ghost'"
              @click="groupBy = 'operation'"
              >По операциям</UButton
            >
            <UButton
              size="xs"
              :variant="groupBy === 'order' ? 'soft' : 'ghost'"
              @click="groupBy = 'order'"
              >По заказам</UButton
            >
          </div>
        </div>
        <UAlert
          v-if="error || localError"
          color="error"
          :title="localError || apiError(error)"
          class="m-4"
        />
        <UAlert
          v-if="resetNotice"
          color="warning"
          title="Соединение восстановлено"
          description="Лента синхронизирована заново. Ранее полученные события доступны в истории."
          class="m-4"
        />
        <div v-if="newCount" class="events__new" role="status">
          <UButton icon="i-lucide-arrow-up" size="sm" @click="showNewest"
            >{{ newCount }} новых событий · к началу</UButton
          >
        </div>
        <div v-if="!pending && !groups.length" class="events__empty">
          <UIcon name="i-lucide-messages-square" />
          <h3>Пока нет событий</h3>
          <p>
            Здесь появятся реальные действия магазина.<br>Попробуйте изменить
            фильтры.
          </p>
        </div>
        <div class="events__messages">
          <template v-for="(group, index) in groups" :key="group.key">
            <div
              v-if="
                index === 0 ||
                day(group.events[0]!.createdAt) !==
                  day(groups[index - 1]!.events[0]!.createdAt)
              "
              class="events__day"
            >
              {{ day(group.events[0]!.createdAt) }}
            </div>
            <article
              class="events__message"
              :class="{
                'events__message--system':
                  group.events[0]!.category === 'SYSTEM',
              }"
            >
              <div class="events__message-heading">
                <span class="events__avatar"
                  ><UIcon
                    :name="
                      category(group.events[0]!.category)?.icon ??
                      'i-lucide-activity'
                    "
                /></span>
                <div class="events__author">
                  <strong>{{ group.events[0]!.actorName }}</strong
                  ><span
                    >{{
                      eventValues[group.events[0]!.actorRole] ??
                      group.events[0]!.actorRole
                    }}
                    ·
                    {{
                      eventValues[group.events[0]!.source] ??
                      group.events[0]!.source
                    }}</span
                  >
                </div>
                <time
                  class="events__time"
                  :datetime="group.events[0]!.createdAt"
                  >{{ time(group.events[0]!.createdAt) }}</time
                >
              </div>
              <div
                v-for="event in group.events"
                :key="event.id"
                class="events__entry"
              >
                <div class="events__entry-heading">
                  <h3>{{ event.title }}</h3>
                  <UBadge
                    size="sm"
                    variant="subtle"
                    :color="event.category === 'SYSTEM' ? 'warning' : 'neutral'"
                    >{{ category(event.category)?.label }}</UBadge
                  ><UBadge
                    v-if="event.ownerOnly"
                    size="sm"
                    variant="outline"
                    color="neutral"
                    >Только владелец</UBadge
                  >
                </div>
                <p v-if="groupBy === 'order'" class="events__entry-author">
                  {{ event.actorName }} ·
                  {{ eventValues[event.actorRole] ?? event.actorRole }} ·
                  {{ eventValues[event.source] ?? event.source }} ·
                  {{ day(event.createdAt) }} · {{ time(event.createdAt) }}
                </p>
                <p class="events__object">
                  {{ operations[event.operation] ?? event.operation }} ·
                  {{ entities[event.entity] ?? event.entity }} #{{
                    event.entityId
                  }}
                </p>
                <dl class="events__changes">
                  <div
                    v-for="key in keys(event).slice(0, 4)"
                    :key="key"
                    class="events__change"
                  >
                    <dt>{{ eventFields[key] ?? key }}</dt>
                    <dd>
                      <span class="events__before">{{
                        eventValue(event.beforeValue?.[key], key)
                      }}</span
                      ><span class="events__arrow" aria-label="изменено на"
                        >→</span
                      ><strong>{{
                        eventValue(event.afterValue?.[key], key)
                      }}</strong>
                    </dd>
                  </div>
                </dl>
                <details v-if="keys(event).length > 4" class="events__details">
                  <summary>Ещё {{ keys(event).length - 4 }} изменений</summary>
                  <dl class="events__changes">
                    <div
                      v-for="key in keys(event).slice(4)"
                      :key="key"
                      class="events__change"
                    >
                      <dt>{{ eventFields[key] ?? key }}</dt>
                      <dd>
                        {{ eventValue(event.beforeValue?.[key], key) }} →
                        {{ eventValue(event.afterValue?.[key], key) }}
                      </dd>
                    </div>
                  </dl>
                </details>
                <div class="events__links">
                  <UButton
                    v-if="event.orderId"
                    :to="`/admin/orders/${event.orderId}`"
                    size="xs"
                    variant="link"
                    >Заказ №{{ event.orderId }} ↗</UButton
                  ><UButton
                    v-if="event.productId && event.operation !== 'DELETE'"
                    :to="`/admin/products/${event.productId}`"
                    size="xs"
                    variant="link"
                    >Открыть товар ↗</UButton
                  ><span>№{{ event.id }}</span>
                </div>
              </div>
              <footer class="events__operation">
                {{ group.events.length }} событий на этой странице ·
                {{
                  groupBy === "order" && group.events[0]!.orderId
                    ? `Заказ №${group.events[0]!.orderId}`
                    : `Операция ${group.events[0]!.requestId.slice(0, 8)}`
                }}
              </footer>
            </article>
          </template>
        </div>
        <div class="events__pagination">
          <UButton
            v-if="history.length"
            variant="outline"
            :disabled="pending"
            @click="newer"
            >Новее</UButton
          ><UButton
            v-if="data?.next"
            variant="outline"
            :loading="pending"
            @click="older"
            >Предыдущие события</UButton
          ><span>Время — Москва · новые события сверху</span>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EventFeed, StoreEvent } from "~/types/events";
import {
  eventCategories,
  eventFields,
  eventValues,
  eventValue,
} from "~/utils/events";
definePageMeta({ middleware: "admin", layout: "admin" });
useHead({ title: "Центр событий · KorzinaMarket" });
const emptyForm = () => ({
  q: "",
  category: "all",
  actorId: "all",
  from: "",
  to: "",
  orderId: "",
});
const form = reactive(emptyForm());
const applied = ref<Record<string, string | number>>({});
const before = ref<number>();
const history = ref<(number | undefined)[]>([]);
const query = computed(() => ({ ...applied.value, before: before.value }));
const { data, error, pending, refresh } = await useApi<EventFeed>(
  "/admin/events",
  { query },
);
const categoryOptions = [
  { value: "all", label: "Все категории" },
  ...eventCategories,
];
const actorOptions = computed(() => [
  { value: "all", label: "Все сотрудники" },
  ...(data.value?.actors ?? []).map((actor) => ({
    value: String(actor.id),
    label: actor.name,
  })),
]);
const apiBase = useRuntimeConfig().public.apiBase;
const localError = ref("");
const filtersOpen = ref(false);
const groupBy = ref<"order" | "operation">("operation");
const newCount = ref(0);
const resetNotice = ref(false);
const connection = ref<"live" | "connecting" | "denied">("connecting");
let stream: EventSource | undefined;
const operations: Record<string, string> = {
  INSERT: "Создано",
  UPDATE: "Изменено",
  DELETE: "Удалено",
};
const entities: Record<string, string> = {
  Order: "Заказ",
  OrderItem: "Позиция",
  OrderPayment: "Оплата",
  OrderExtra: "Доплата",
  OrderItemPriceChange: "Цена позиции",
  Product: "Товар",
  ProductImage: "Фото товара",
  MarketPoint: "Торговая точка",
  MarketLayout: "Карта рынка",
  SeasonTemplate: "Сезон",
  HomeSlide: "Слайд главной",
  ShopHours: "Расписание",
  ShopHoursException: "Исключение расписания",
  PromoCode: "Промокод",
  PartnerPayout: "Выплата партнёру",
  OrderCancellation: "Отмена заказа",
  OrderIssue: "Согласование",
  OrderChatMessage: "Сообщение по заказу",
  OrderChatImageRevision: "Фото по заказу",
  System: "Система",

  Category: "Категория",
  ShopSettings: "Настройки",
  Delivery: "Доставка",
  DeliveryAttempt: "Заявка доставки",
  User: "Пользователь",
  MarketPointOwner: "Права на точку",
  OrderNotification: "Уведомление",
  AdminChange: "Уведомление владельцу",
};
const category = (value: string) =>
  eventCategories.find((item) => item.value === value);
const day = (value: string) =>
  new Date(value).toLocaleDateString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
const time = (value: string) =>
  new Date(value).toLocaleTimeString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  });
const keys = (event: StoreEvent) => [
  ...new Set([
    ...Object.keys(event.beforeValue ?? {}),
    ...Object.keys(event.afterValue ?? {}),
  ]),
];
const groups = computed(() => {
  if (connection.value === "denied") return [];
  const result = new Map<string, { key: string; events: StoreEvent[] }>();
  for (const event of data.value?.items ?? []) {
    const key =
      groupBy.value === "order" && event.orderId
        ? `order:${event.orderId}`
        : event.requestId;
    const group = result.get(key) ?? { key, events: [] };
    group.events.push(event);
    result.set(key, group);
  }
  return [...result.values()];
});
function apply() {
  if (form.from && form.to && form.from > form.to) {
    localError.value = "Дата начала позже даты окончания";
    return;
  }
  if (
    form.orderId &&
    (!Number.isSafeInteger(Number(form.orderId)) ||
      Number(form.orderId) < 1 ||
      Number(form.orderId) > 2147483647)
  ) {
    localError.value = "Укажите корректный номер заказа";
    return;
  }
  stream?.close();
  connection.value = "connecting";
  localError.value = "";
  history.value = [];
  before.value = undefined;
  newCount.value = 0;
  applied.value = Object.fromEntries(
    Object.entries({
      q: form.q.trim(),
      category: form.category === "all" ? "" : form.category,
      actorId: form.actorId === "all" ? "" : form.actorId,
      from: form.from,
      to: form.to,
      orderId: form.orderId,
    }).filter(([, value]) => value !== ""),
  );
}
function resetFilters() {
  Object.assign(form, emptyForm());
  apply();
}
function older() {
  if (!data.value?.next) return;
  history.value.push(before.value);
  before.value = data.value.next;
}
function newer() {
  before.value = history.value.pop();
}
async function showNewest() {
  history.value = [];
  before.value = undefined;
  newCount.value = 0;
  resetNotice.value = false;
  await refresh();
}
function connect() {
  stream?.close();
  if (!data.value?.cursor || connection.value === "denied") return;
  const url = new URL(`${apiBase}/admin/events/stream`, window.location.origin);
  for (const [key, value] of Object.entries(applied.value))
    url.searchParams.set(key, String(value));
  url.searchParams.set("cursor", data.value.cursor);
  stream = new EventSource(url, { withCredentials: true });
  stream.onopen = () => {
    connection.value = "live";
  };
  stream.onerror = () => {
    connection.value = "connecting";
  };
  stream.addEventListener("sync", (message) => {
    try {
      const value: unknown = JSON.parse((message as MessageEvent<string>).data);
      if (
        typeof value !== "object" ||
        !value ||
        !("count" in value) ||
        typeof value.count !== "number" ||
        value.count < 0
      )
        return;
      newCount.value += value.count;
      if (value.count && before.value === undefined) void refresh();
    } catch {
      connection.value = "connecting";
    }
  });
  stream.addEventListener("reset", () => {
    resetNotice.value = true;
    void refresh();
  });
  stream.addEventListener("denied", () => {
    connection.value = "denied";
    stream?.close();
    data.value = undefined;
    localError.value = "Доступ изменён. Войдите заново.";
  });
}
onMounted(connect);
// Reconnect after each completed load, including a cached response whose cursor
// did not change. Watching the cursor alone leaves filter changes disconnected.
watch([data, pending], ([value, loading]) => {
  if (import.meta.client && value && !loading) connect();
});
onBeforeUnmount(() => stream?.close());
</script>

<style scoped>
.events {
  --event-green: #23694d;
}
.events__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.events__eyebrow {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--event-green);
  margin-bottom: 0.5rem;
}
.events__title {
  font-size: clamp(1.6rem, 3vw, 2.2rem);
  font-weight: 700;
  letter-spacing: -0.035em;
}
.events__subtitle {
  color: var(--ui-text-muted);
  font-size: 0.9rem;
  margin-top: 0.3rem;
}
.events__connection {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 2rem;
  padding: 0.5rem 0.8rem;
}
.events__dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: #b18b42;
}
.events__dot--live {
  background: #368b67;
  box-shadow: 0 0 0 3px #368b671a;
}
.events__workspace {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 1.5rem;
  align-items: start;
}
.events__filters {
  min-width: 0;
  position: sticky;
  top: 1rem;
  padding: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: var(--ui-bg);
}
.events__filter-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.events__form {
  display: grid;
  gap: 1rem;
}
.events__filter-toggle {
  display: none;
}
.events__date-range {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
.events__privacy {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  border-top: 1px solid var(--ui-border);
  margin-top: 1.2rem;
  padding-top: 1rem;
  font-size: 0.72rem;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.events__privacy > span {
  flex-shrink: 0;
  margin-top: 0.15rem;
}
.events__conversation {
  min-width: 0;
  position: relative;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--ui-bg-muted) 60%, var(--ui-bg));
  overflow: hidden;
}
.events__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.events__total {
  display: block;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
  margin-top: 0.15rem;
}
.events__group-control {
  display: flex;
  gap: 0.2rem;
}
.events__messages {
  padding: 0.5rem 1.5rem 1.5rem;
}
.events__day {
  width: fit-content;
  margin: 1.25rem auto 1rem;
  padding: 0.25rem 0.7rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  font-size: 0.7rem;
  color: var(--ui-text-muted);
  background: var(--ui-bg);
}
.events__message {
  margin-bottom: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem 1rem 1rem 0.25rem;
  background: var(--ui-bg);
  box-shadow: 0 2px 3px #00000003;
  overflow: hidden;
}
.events__message--system {
  border-color: color-mix(in srgb, #bd8f36 40%, var(--ui-border));
}
.events__message-heading {
  display: flex;
  gap: 0.7rem;
  padding: 1rem 1rem 0.5rem;
  align-items: center;
}
.events__avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2.15rem;
  height: 2.15rem;
  border-radius: 0.75rem;
  background: #35805b15;
  color: var(--event-green);
}
.events__author {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.events__author strong {
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.events__author > span,
.events__time {
  color: var(--ui-text-muted);
  font-size: 0.68rem;
}
.events__time {
  margin-left: auto;
  flex-shrink: 0;
}
.events__entry {
  padding: 0.75rem 1rem;
}
.events__entry + .events__entry {
  border-top: 1px dashed var(--ui-border);
}
.events__entry-heading {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  align-items: center;
}
.events__entry-heading h3 {
  font-size: 0.9rem;
  font-weight: 650;
  margin-right: auto;
}
.events__object,
.events__entry-author {
  font-size: 0.72rem;
  color: var(--ui-text-muted);
  margin-top: 0.35rem;
}
.events__changes {
  margin-top: 0.8rem;
  background: var(--ui-bg-muted);
  border-radius: 0.6rem;
  padding: 0.25rem 0.75rem;
}
.events__change {
  display: grid;
  grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr);
  gap: 0.75rem;
  padding: 0.45rem 0;
  font-size: 0.75rem;
}
.events__change + .events__change {
  border-top: 1px solid var(--ui-border);
}
.events__change dt {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.events__change dd {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  overflow-wrap: anywhere;
  min-width: 0;
}
.events__change strong {
  font-weight: 500;
  overflow-wrap: anywhere;
  min-width: 0;
}
.events__before {
  color: var(--ui-text-muted);
  text-decoration: line-through;
  text-decoration-color: var(--ui-border-accented);
}
.events__arrow {
  color: var(--ui-text-dimmed);
}
.events__details {
  margin-top: 0.5rem;
  font-size: 0.75rem;
}
.events__details summary {
  color: var(--event-green);
  cursor: pointer;
}
.events__links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.65rem;
}
.events__links > span {
  font-size: 0.65rem;
  color: var(--ui-text-dimmed);
  margin-left: auto;
}
.events__operation {
  padding: 0.5rem 1rem;
  background: color-mix(in srgb, var(--ui-bg-muted) 50%, var(--ui-bg));
  color: var(--ui-text-dimmed);
  font-size: 0.65rem;
  border-top: 1px solid var(--ui-border);
}
.events__new {
  position: sticky;
  top: 1rem;
  z-index: 2;
  display: flex;
  justify-content: center;
  padding: 0.75rem;
}
.events__empty {
  text-align: center;
  padding: 4rem 1rem;
  color: var(--ui-text-muted);
}
.events__empty > span {
  width: 2.5rem;
  height: 2.5rem;
  margin-bottom: 1rem;
}
.events__empty h3 {
  font-weight: 600;
  color: var(--ui-text);
  margin-bottom: 0.5rem;
}
.events__empty p {
  font-size: 0.8rem;
  line-height: 1.6;
}
.events__pagination {
  padding: 1rem;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem;
  align-items: center;
}
.events__pagination > span {
  flex-basis: 100%;
  text-align: center;
  font-size: 0.68rem;
  color: var(--ui-text-muted);
}
@media (max-width: 900px) {
  .events__workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
  }
  .events__filters {
    position: static;
  }
  .events__form {
    display: none;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .events__filters--open .events__form {
    display: grid;
  }
  .events__filter-toggle {
    display: inline-flex;
  }
  .events__date-range {
    display: contents;
  }
  .events__privacy {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
  }
  .events__messages {
    padding: 0.25rem 0.75rem 0.75rem;
  }
}
@media (max-width: 480px) {
  .events__form {
    grid-template-columns: minmax(0, 1fr);
  }
  .events__header {
    gap: 0.75rem;
  }
  .events__toolbar {
    padding: 1rem;
  }
  .events__messages {
    padding: 0 0.5rem 0.5rem;
  }
  .events__message-heading {
    padding: 0.75rem 0.75rem 0.25rem;
  }
  .events__entry {
    padding: 0.65rem 0.75rem;
  }
  .events__change {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.2rem;
  }
  .events__entry-heading h3 {
    width: 100%;
  }
  .events__author > span {
    font-size: 0.62rem;
  }
  .events__avatar {
    width: 1.85rem;
    height: 1.85rem;
  }
  .events__connection {
    font-size: 0.7rem;
  }
}
</style>
