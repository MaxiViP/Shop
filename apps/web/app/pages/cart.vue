<template>
  <UContainer class="checkout">
    <header class="checkout__head">
      <h1 class="checkout__title">Корзина и оформление</h1>
      <UButton v-if="cart.restored && cart.count" variant="ghost" color="neutral" :disabled="loading" class="checkout__clear" @click="clearCart">
        Очистить
      </UButton>
    </header>

    <UAlert
      v-if="cart.storageWarning"
      class="mb-4"
      color="warning"
      :title="cart.storageWarning"
    />
    <UAlert
      v-if="cart.priceChanged"
      class="mb-4"
      color="info"
      title="Цена некоторых товаров изменилась. Проверьте обновлённую сумму."
    />
    <UAlert
      v-if="quoteError || settingsError"
      class="mb-4"
      color="error"
      title="Не удалось проверить корзину"
      :description="quoteError || 'Не удалось загрузить способы получения.'"
      :actions="[{ label: 'Повторить', onClick: retryQuote }]"
    />
    <div v-if="!cart.restored" class="space-y-4" role="status" aria-live="polite">
      <p>Восстанавливаем корзину…</p>
      <USkeleton class="h-48 w-full" />
    </div>
    <div v-else-if="!cart.count" class="checkout__empty">
      <UIcon name="i-lucide-shopping-bag" class="checkout__empty-icon" />
      <h2>Корзина пустая</h2>
      <p>Добавьте свежие продукты из каталога.</p>
      <UButton to="/catalog" size="lg">Перейти в каталог</UButton>
    </div>
    <form v-else class="checkout__layout" @submit.prevent="submit">
      <fieldset class="checkout__main" :disabled="loading">
        <legend class="sr-only">Товары и данные заказа</legend>
        <section class="section">
          <h2 class="section__title">Ваши товары</h2>
          <CartItems />
          <p v-if="!ready || !settings || settingsError" class="section__hint" role="status">
            {{ quoteError || settingsError
              ? 'Оформление будет доступно после проверки корзины. Товары можно редактировать.'
              : 'Проверяем актуальные цены и способы получения…' }}
          </p>
          <UAlert v-if="ready && cart.quote?.error === 'TOTAL_OVERFLOW'" class="mt-4" color="error" title="Сумма корзины слишком велика. Уменьшите количество или удалите позиции." />
        </section>
        <section class="section">
          <h2 class="section__title">Получение</h2>

          <UAlert
            v-if="ready && !cart.quote?.valid"
            class="mb-4"
            color="warning"
            title="Проверьте корзину"
            description="Некоторые товары или количество недоступны для заказа. Исправьте отмеченные позиции выше."
          />
          <OrderDeliveryMinimum
            v-if="cart.total !== null"
            :settings="settings"
            :subtotal="cart.total"
          />
          <p v-if="settings && !settings.pickupEnabled" class="text-muted">
            Самовывоз временно недоступен.
          </p>
          <div class="type">
            <button
              type="button"
              class="type__item"
              :disabled="!eligibility?.delivery"
              :class="{ 'type__item--active': form.type === 'DELIVERY' }"
              :aria-pressed="form.type === 'DELIVERY'"
              @click="form.type = 'DELIVERY'"
            >
              <UIcon name="i-lucide-truck" />

              <span>
                <strong>Доставка</strong>
                <small>По Москве</small>
              </span>
            </button>

            <button
              type="button"
              class="type__item"
              :disabled="!eligibility?.pickup"
              :class="{ 'type__item--active': form.type === 'PICKUP' }"
              :aria-pressed="form.type === 'PICKUP'"
              @click="form.type = 'PICKUP'"
            >
              <UIcon name="i-lucide-store" />

              <span>
                <strong>Самовывоз</strong>
                <small>С рынка</small>
              </span>
            </button>
          </div>
        </section>

        <section class="section">
          <h2 class="section__title">Получатель</h2>

          <div class="form__row">
            <UFormField  label="Имя" :error="errors.name">
              <AppTextInput
                v-model="form.name"
                autocomplete="name"
                placeholder="Максим"
                size="lg"
              />
            </UFormField>

            <UFormField label="Телефон" :error="errors.phone">
              <AppTextInput
                v-model="form.phone"
                format="phone"
                type="tel"
                inputmode="tel"
                autocomplete="tel"
                placeholder="+7 999 123-45-67"
                size="lg"
              />
            </UFormField>
          </div>

          <p v-if="!auth.loggedIn" class="section__hint">
            Регистрация не требуется. Мы используем номер только для связи по
            заказу.
          </p>
        </section>

        <section v-if="form.type === 'DELIVERY'" class="section">
          <div class="section__head">
            <h2 class="section__title">Адрес доставки</h2>

            <NuxtLink v-if="auth.loggedIn" to="/profile" class="section__link">
              Мои адреса
            </NuxtLink>
          </div>

          <div v-if="auth.loggedIn && addresses.length" class="addresses">
            <button
              v-for="address in addresses"
              :key="address.id"
              type="button"
              class="addresses__item"
              :class="{
                'addresses__item--active': selectedAddressId === address.id,
              }"
              @click="selectAddress(address)"
            >
              <span class="addresses__top">
                <strong>
                  {{ address.label }}
                </strong>

                <UBadge v-if="address.isDefault" color="success" variant="soft">
                  Основной
                </UBadge>
              </span>

              <span class="addresses__text">
                {{ addressText(address) }}
              </span>
            </button>

            <button
              type="button"
              class="addresses__item"
              :class="{
                'addresses__item--active': selectedAddressId === null,
              }"
              @click="manualAddress"
            >
              <span class="addresses__top">
                <strong> Другой адрес </strong>
              </span>

              <span class="addresses__text"> Ввести вручную </span>
            </button>
          </div>

          <div v-if="showAddressForm" class="address">
            <div class="form__row">
              <UFormField label="Город" :error="errors.city">
                <AppTextInput v-model="form.city" placeholder="Москва" />
              </UFormField>

              <UFormField label="Улица" :error="errors.street">
                <AppTextInput
                  v-model="form.street"
                  placeholder="Ленинский проспект"
                />
              </UFormField>
            </div>

            <div class="form__grid">
              <UFormField label="Дом" :error="errors.house">
                <UInput v-model="form.house" placeholder="53" />
              </UFormField>

              <UFormField label="Квартира">
                <UInput v-model="form.flat" placeholder="25" />
              </UFormField>

              <UFormField label="Подъезд">
                <UInput v-model="form.entrance" placeholder="2" />
              </UFormField>

              <UFormField label="Этаж">
                <UInput v-model="form.floor" placeholder="7" />
              </UFormField>
            </div>

            <UFormField label="Домофон">
              <UInput v-model="form.intercom" placeholder="25К" />
            </UFormField>

            <UFormField label="Комментарий курьеру">
              <UTextarea
                v-model="form.comment"
                placeholder="Позвонить за 10 минут"
                :rows="3"
              />
            </UFormField>
          </div>
        </section>

        <section v-if="form.type === 'DELIVERY'" class="section">
          <h2 class="section__title">Время доставки</h2>

          <UAlert
            color="neutral"
            variant="soft"
            title="Доставим как можно скорее"
            description="Точные интервалы доставки добавим следующим этапом."
          />
        </section>

        <section v-else class="section">
          <h2 class="section__title">Самовывоз</h2>
          <OrderPickupPoint />
          <fieldset class="pickup-time">
            <legend class="section__title">Когда подготовить?</legend>
            <label class="pickup-time__option">
              <input
                v-model="form.pickupTiming"
                type="radio"
                value="asap"
                name="pickup-timing"
              >
              <span>Начать собирать сразу</span>
            </label>
            <p v-if="form.pickupTiming === 'asap'" class="section__hint">
              Начнём подготовку заказа сразу после его принятия.
            </p>
            <label class="pickup-time__option">
              <input
                v-model="form.pickupTiming"
                type="radio"
                value="scheduled"
                name="pickup-timing"
              >
              <span>Ко времени</span>
            </label>
            <UFormField
              v-if="form.pickupTiming === 'scheduled'"
              label="Дата и время (Москва)"
              :error="errors.deliveryAt"
              required
            >
              <UInput
                v-model="form.pickupAt"
                type="datetime-local"
                required
                size="lg"
              />
            </UFormField>
          </fieldset>
        </section>

        <section class="section">
          <h2 class="section__title">Оплата</h2>
          <p>После сборки заказа и фактического взвешивания товаров.</p>
          <p v-if="form.type === 'DELIVERY'" class="section__hint">Доставка оплачивается отдельно.</p>
        </section>

        <UAlert
          v-if="error"
          color="error"
          title="Не удалось оформить заказ"
          :description="error"
        />
      </fieldset>

      <aside class="summary">
        <h2 class="summary__title">Ваш заказ</h2>

        <div v-if="cart.total !== null" class="summary__row">
          <span>Предварительная стоимость товаров</span>

          <span> ≈ {{ money(cart.total ?? 0) }} </span>
        </div>

        <div class="summary__row">
          <span>{{ form.type === "PICKUP" ? "Самовывоз" : "Доставка" }}</span>

          <span>{{
            form.type === "PICKUP" ? "Бесплатно" : "Рассчитывается"
          }}</span>
        </div>

        <div v-if="cart.total !== null" class="summary__total">
          <span> Предварительно за товары </span>

          <strong> ≈ {{ money(cart.total ?? 0) }} </strong>
        </div>

        <div class="summary__submit">
          <div class="summary__submit-total">
            <small>Предварительно за товары</small>
            <strong>{{ cart.total !== null ? money(cart.total) : 'Рассчитывается' }}</strong>
          </div>
        <UButton
          type="submit"
          block
          size="xl"
          :loading="loading"
          :disabled="!canSubmit"
        >
          Оформить заказ
        </UButton>
        </div>

        <p class="summary__note">
          Итоговая стоимость будет рассчитана после сборки и фактического
          взвешивания товаров. Оплата — после сборки заказа.
          <span v-if="form.type === 'DELIVERY'"
            >Доставка оплачивается отдельно.</span
          >
        </p>
      </aside>
    </form>
  </UContainer>
</template>

<script setup lang="ts">
import type { Address } from "~/types/address";
import type { OrderCreated, OrderType } from "~/types/order";
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { pickupDate } from "~/utils/pickup";
import {
  deliveryEligibility,
  type PublicShopSettings,
} from "~/utils/shop-settings";
const {
  data: settings,
  error: settingsError,
  refresh: refreshSettings,
} = await useApi<PublicShopSettings>("/shop/settings");

const auth = useAuthStore();
const cart = useCartStore();
const {
  ready,
  pending: quotePending,
  error: quoteError,
  refresh: refreshQuote,
} = useCartQuote();
const eligibility = computed(() =>
  ready.value && cart.total !== null && settings.value && !settingsError.value
    ? deliveryEligibility(cart.total, settings.value)
    : null,
);
const api = useApiClient();
const { name, rememberOnSuccess } = useCheckoutName();

const { data: addressData } = await useApi<Address[]>("/addresses", {
  default: () => [],
  immediate: auth.loggedIn,
});

const addresses = computed(() => addressData.value ?? []);

const selectedAddressId = ref<number | null>(null);

const loading = ref(false);
const error = ref("");

const errors = reactive({
  name: "",
  phone: "",
  city: "",
  street: "",
  house: "",
  deliveryAt: "",
});

const form = reactive({
  type: "DELIVERY" as OrderType,
  pickupTiming: "asap",
  pickupAt: "",
  name,
  phone: auth.user?.phone ?? "",

  city: "Москва",
  street: "",
  house: "",
  flat: "",
  entrance: "",
  floor: "",
  intercom: "",
  comment: "",
});

const canSubmit = computed(
  () =>
    !loading.value &&
    !quotePending.value &&
    ready.value &&
    cart.count > 0 &&
    cart.quote?.valid &&
    (form.type === "DELIVERY"
      ? eligibility.value?.delivery
      : eligibility.value?.pickup),
);
const notice = useHeaderNotice();
function clearCart() {
  cart.clear();
  notice.show({ target: 'cart', text: 'Корзина очищена' });
}
async function retryQuote() {
  await Promise.all([refreshQuote(), refreshSettings()]);
}
watch(
  eligibility,
  (value) => {
    if (form.type === "DELIVERY" && !value?.delivery && value?.pickup)
      form.type = "PICKUP";
    else if (form.type === "PICKUP" && !value?.pickup && value?.delivery)
      form.type = "DELIVERY";
  },
  { immediate: true },
);

watch(
  () => [form.type, form.pickupTiming],
  () => {
    clearErrors();
    error.value = "";
  },
);

const showAddressForm = computed(
  () =>
    !auth.loggedIn ||
    !addresses.value.length ||
    selectedAddressId.value === null,
);

watch(
  addresses,
  (value) => {
    if (!value.length) return;

    const address = value.find((item) => item.isDefault) ?? value[0];

    if (!address) return;

    selectAddress(address);
  },
  {
    immediate: true,
  },
);

function selectAddress(address: Address) {
  selectedAddressId.value = address.id;

  form.city = address.city;
  form.street = address.street;
  form.house = address.house;
  form.flat = address.flat ?? "";
  form.entrance = address.entrance ?? "";
  form.floor = address.floor ?? "";
  form.intercom = address.intercom ?? "";
  form.comment = address.comment ?? "";
}

function manualAddress() {
  selectedAddressId.value = null;

  form.city = "Москва";
  form.street = "";
  form.house = "";
  form.flat = "";
  form.entrance = "";
  form.floor = "";
  form.intercom = "";
  form.comment = "";
}

function validate() {
  clearErrors();

  if (!form.name.trim()) {
    errors.name = "Введите имя";
  }

  if (!form.phone.trim()) {
    errors.phone = "Введите телефон";
  }

  if (form.type === "DELIVERY" && !form.city.trim()) {
    errors.city = "Введите город";
  }

  if (form.type === "DELIVERY" && !form.street.trim()) {
    errors.street = "Введите улицу";
  }

  if (form.type === "DELIVERY" && !form.house.trim()) {
    errors.house = "Введите дом";
  }

  if (form.type === "PICKUP" && form.pickupTiming === "scheduled") {
    const date = pickupDate(form.pickupAt);
    if (!date || date.getTime() <= Date.now())
      errors.deliveryAt = "Укажите дату и время в будущем";
  }
  return !Object.values(errors).some(Boolean);
}

function clearErrors() {
  errors.name = "";
  errors.phone = "";
  errors.city = "";
  errors.street = "";
  errors.house = "";
  errors.deliveryAt = "";
}

async function submit() {
  if (!canSubmit.value) return;
  if (loading.value) return;
  if (!validate()) return;

  loading.value = true;
  error.value = "";

  const rememberName = rememberOnSuccess();
  try {
    const previousToken = cart.quote?.token;
    const requestedType = form.type;
    const [refreshed] = await Promise.all([refreshQuote(), refreshSettings()]);
    if (!refreshed || settingsError.value || !cart.quote?.valid) return;
    if (
      previousToken !== cart.quote.token ||
      requestedType !== form.type ||
      !(form.type === "DELIVERY"
        ? eligibility.value?.delivery
        : eligibility.value?.pickup)
    ) {
      error.value =
        "Условия заказа изменились. Проверьте товары, сумму и способ получения перед оформлением.";
      return;
    }
    const order = await api<OrderCreated>("/orders", {
      method: "POST",

      body: {
        type: form.type,
        quoteToken: cart.quote.token,
        deliveryAt:
          form.type === "PICKUP" && form.pickupTiming === "scheduled"
            ? pickupDate(form.pickupAt)?.toISOString()
            : undefined,

        customerName: form.name.trim(),

        customerPhone: form.phone.trim(),

        address:
          form.type === "DELIVERY"
            ? {
                city: form.city.trim(),
                street: form.street.trim(),
                house: form.house.trim(),

                flat: form.flat.trim() || undefined,

                entrance: form.entrance.trim() || undefined,

                floor: form.floor.trim() || undefined,

                intercom: form.intercom.trim() || undefined,

                comment: form.comment.trim() || undefined,
              }
            : undefined,

        items: cart.items.map((item) => ({
          productId: item.product.id,
          qty: item.qty,
        })),
      },
    });

    rememberName();
    cart.clear();

    await navigateTo(`/order/${order.publicId}`);
  } catch (cause) {
    const message = getMessage(cause);
    // No automatic POST retry: refresh data, then require another deliberate submit.
    await retryQuote();
    error.value = message;
  } finally {
    loading.value = false;
  }
}

function addressText(address: Address) {
  return [
    address.city,
    address.street,
    `д. ${address.house}`,

    address.flat ? `кв. ${address.flat}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function getMessage(cause: unknown) {
  if (typeof cause === "object" && cause && "data" in cause) {
    const data = cause.data;

    if (typeof data === "object" && data && "message" in data) {
      const message = data.message;

      if (typeof message === "string") {
        return message;
      }

      if (Array.isArray(message)) {
        return message.join(", ");
      }
    }
  }

  return "Попробуйте ещё раз";
}

useSeoMeta({
  title: "Корзина и оформление",
});
</script>

<style scoped>
.checkout {
  min-width: 0;
  padding-block: var(--page-start) calc(var(--page-end) + 6rem + var(--safe-bottom));
}

.checkout__clear,
.checkout__empty :deep(a) {
  min-height: var(--touch-target);
  flex-shrink: 0;
}

.checkout__empty {
  display: grid;
  justify-items: center;
  gap: 1rem;
  margin: var(--section-gap) auto;
  text-align: center;
}

.checkout__empty-icon {
  width: 3rem;
  height: 3rem;
  color: var(--ui-text-muted);
}

.summary__submit {
  position: fixed;
  inset-inline: 0;
  bottom: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem max(var(--page-x), var(--safe-right))
    max(0.75rem, var(--safe-bottom)) max(var(--page-x), var(--safe-left));
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.summary__submit-total {
  display: grid;
  min-width: 0;
  gap: 0.125rem;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.summary__submit-total small {
  color: var(--ui-text-muted);
  font-size: 0.75rem;
}

.summary__submit :deep(button) {
  min-height: var(--touch-target);
  white-space: nowrap;
}

.type__item:focus-visible,
.addresses__item:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.pickup-time {
  display: grid;
  gap: 0.75rem;
  margin-top: 1.5rem;
  min-width: 0;
}

.pickup-time__option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: var(--touch-target);
  cursor: pointer;
}

.checkout__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: var(--card-padding);
}

.section__link {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch-target);
  color: var(--ui-text-muted);
}

.section__link:hover {
  color: var(--ui-primary);
}

.checkout__title {
  margin-top: 0;
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
}

.checkout__layout {
  display: grid;
  min-width: 0;
  gap: 1.5rem;
}

.checkout__main {
  display: grid;
  min-width: 0;
  gap: 1.5rem;
}

.section {
  min-width: 0;
  padding: var(--card-padding);
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}

.section__title {
  margin-bottom: 1.25rem;
  font-size: var(--section-title);
  font-weight: 700;
}

.section__head .section__title {
  margin-bottom: 0;
}

.section__hint {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

.type {
  display: grid;
  gap: 1rem;
}

.type__item {
  display: flex;
  min-height: calc(var(--touch-target) + 1rem);
  align-items: center;
  gap: 1rem;
  padding: var(--card-padding);
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  text-align: left;
  overflow-wrap: anywhere;
}

.type__item--active {
  border-color: var(--ui-primary);
  background: var(--ui-bg-elevated);
}

.type__item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.type__item svg {
  width: 1.5rem;
  height: 1.5rem;
}

.type__item span {
  display: grid;
}

.type__item small {
  color: var(--ui-text-muted);
}

.form__row {
  display: grid;
  min-width: 0;
  gap: 1rem;

}

.form__grid {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.address {
  display: grid;
  min-width: 0;
  gap: 1rem;
  margin-top: 1rem;
}

.addresses {
  display: grid;
  gap: 1rem;
  margin-top: 1.25rem;
}

.addresses__item {
  display: grid;
  min-width: 0;
  min-height: var(--touch-target);
  gap: 0.5rem;
  padding: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  text-align: left;
}

.addresses__item--active {
  border-color: var(--ui-primary);
}

.addresses__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.addresses__text {
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}

.summary {
  min-width: 0;
  align-self: start;
  padding: var(--card-padding);
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.summary__title {
  font-size: 1.25rem;
  font-weight: 700;
}

.summary__row,
.summary__total {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem 1rem;
}

.summary__row {
  margin-top: 0.75rem;
  color: var(--ui-text-muted);
}

.summary__total {
  margin-block: 1.25rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--ui-border);
  font-size: var(--section-title);
}

.summary__row > *,
.summary__total > * {
  min-width: 0;
  overflow-wrap: anywhere;
}

.summary__row > :last-child,
.summary__total > :last-child {
  margin-left: auto;
  text-align: right;
}

.summary__note {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  line-height: 1.5;
}

.checkout :deep(input),
.checkout :deep(textarea),
.checkout :deep(select) {
  font-size: 1rem;
}

@media (min-width: 40rem) {
  .type,
  .form__row,
  .form__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 48rem) {
  .addresses {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .form__grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (min-width: 64rem) {
  .checkout {
    padding-bottom: var(--page-end);
  }

  .summary__submit {
    position: static;
    display: block;
    padding: 0;
    border: 0;
  }

  .summary__submit-total {
    display: none;
  }

  .checkout__layout {
    grid-template-columns: minmax(0, 1fr) minmax(20rem, 23.75rem);
    gap: 2rem;
  }

  .summary {
    position: sticky;
    top: calc(var(--header-height) + 1rem);
  }
}
</style>
