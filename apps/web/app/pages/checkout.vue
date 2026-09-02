<template>
  <UContainer class="checkout">
    <header class="checkout__head">
      <NuxtLink to="/cart" class="checkout__back"> ← Корзина </NuxtLink>

      <h1 class="checkout__title">Оформление заказа</h1>
    </header>

    <div class="checkout__layout">
      <main class="checkout__main">
        <section class="section">
          <h2 class="section__title">Получение</h2>

          <div class="type">
            <button type="button" class="type__item type__item--active">
              <UIcon name="i-lucide-truck" />

              <span>
                <strong>Доставка</strong>
                <small>По Москве</small>
              </span>
            </button>

            <button type="button" class="type__item" disabled>
              <UIcon name="i-lucide-store" />

              <span>
                <strong>Самовывоз</strong>
                <small>Скоро</small>
              </span>
            </button>
          </div>
        </section>

        <section class="section">
          <h2 class="section__title">Получатель</h2>

          <div class="form__row">
            <UFormField label="Имя" :error="errors.name">
              <UInput
                v-model="form.name"
                autocomplete="name"
                placeholder="Максим"
                size="lg"
              />
            </UFormField>

            <UFormField label="Телефон" :error="errors.phone">
              <UInput
                v-model="form.phone"
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

        <section class="section">
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
                <UInput v-model="form.city" placeholder="Москва" />
              </UFormField>

              <UFormField label="Улица" :error="errors.street">
                <UInput
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

        <section class="section">
          <h2 class="section__title">Время доставки</h2>

          <UAlert
            color="neutral"
            variant="soft"
            title="Доставим как можно скорее"
            description="Точные интервалы доставки добавим следующим этапом."
          />
        </section>

        <UAlert
          v-if="error"
          color="error"
          title="Не удалось оформить заказ"
          :description="error"
        />
      </main>

      <aside class="summary">
        <h2 class="summary__title">Ваш заказ</h2>

        <div class="summary__items">
          <div
            v-for="item in cart.items"
            :key="item.product.id"
            class="summary__item"
          >
            <div>
              <strong>
                {{ item.product.name }}
              </strong>

              <small>
                {{ qtyText(item.product.unit, item.qty) }}
              </small>
            </div>

            <span>
              {{ money(cart.lineTotal(item)) }}
            </span>
          </div>
        </div>

        <div class="summary__row">
          <span>Товары</span>

          <span>
            {{ money(cart.total) }}
          </span>
        </div>

        <div class="summary__row">
          <span>Доставка</span>

          <span> Бесплатно </span>
        </div>

        <div class="summary__total">
          <span> Итого </span>

          <strong>
            {{ money(cart.total) }}
          </strong>
        </div>

        <UButton block size="xl" :loading="loading" @click="submit">
          Оформить заказ
        </UButton>

        <p class="summary__note">
          Итоговая сумма весовых товаров может немного измениться после сборки.
        </p>
      </aside>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import type { Address } from "~/types/address";
import type { OrderCreated } from "~/types/order";
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { qtyText } from "~/utils/qty";

const auth = useAuthStore();
const cart = useCartStore();
const api = useApiClient();

if (!cart.items.length) {
  await navigateTo("/cart");
}

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
});

const form = reactive({
  name: auth.user?.name ?? "",
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

  if (!form.city.trim()) {
    errors.city = "Введите город";
  }

  if (!form.street.trim()) {
    errors.street = "Введите улицу";
  }

  if (!form.house.trim()) {
    errors.house = "Введите дом";
  }

  return !Object.values(errors).some(Boolean);
}

function clearErrors() {
  errors.name = "";
  errors.phone = "";
  errors.city = "";
  errors.street = "";
  errors.house = "";
}

async function submit() {
  if (loading.value) return;
  if (!validate()) return;

  loading.value = true;
  error.value = "";

  try {
    const order = await api<OrderCreated>("/orders", {
      method: "POST",

      body: {
        type: "DELIVERY",

        customerName: form.name.trim(),

        customerPhone: form.phone.trim(),

        address: {
          city: form.city.trim(),
          street: form.street.trim(),
          house: form.house.trim(),

          flat: form.flat.trim() || undefined,

          entrance: form.entrance.trim() || undefined,

          floor: form.floor.trim() || undefined,

          intercom: form.intercom.trim() || undefined,

          comment: form.comment.trim() || undefined,
        },

        items: cart.items.map((item) => ({
          productId: item.product.id,
          qty: item.qty,
        })),
      },
    });

    cart.clear();

    await navigateTo(`/order/${order.publicId}`);
  } catch (cause) {
    error.value = getMessage(cause);
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
  title: "Оформление заказа",
});
</script>

<style scoped>
.checkout {
  min-width: 0;
  padding-block: var(--page-start) var(--page-end);
}

.checkout__head {
  margin-bottom: 2rem;
}

.checkout__back,
.section__link {
  color: var(--ui-text-muted);
}

.checkout__back:hover,
.section__link:hover {
  color: var(--ui-primary);
}

.checkout__title {
  margin-top: 0.75rem;
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
  min-height: 90px;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
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
  gap: 1rem;
}

.form__grid {
  display: grid;
  gap: 1rem;
}

.address {
  display: grid;
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

.summary__items {
  display: grid;
  gap: 1rem;
  margin-block: 1.5rem;
}

.summary__item {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.summary__item > div {
  display: grid;
  min-width: 0;
}

.summary__item strong,
.summary__item span {
  overflow-wrap: anywhere;
}

.summary__item small {
  margin-top: 0.2rem;
  color: var(--ui-text-muted);
}

.summary__row,
.summary__total {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.summary__row {
  margin-top: 0.75rem;
  color: var(--ui-text-muted);
}

.summary__total {
  margin-block: 1.25rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--ui-border);
  font-size: 1.25rem;
}

.summary__note {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.75rem;
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
  .checkout__layout {
    grid-template-columns: minmax(0, 1fr) minmax(20rem, 23.75rem);
    gap: 2rem;
  }

  .summary {
    position: sticky;
    top: 1.5rem;
  }
}
</style>
