<template>
  <UContainer class="checkout">
    <header class="checkout__head">
      <h1 class="checkout__title">Корзина и оформление</h1>
      <UButton v-if="cart.restored && cart.count" variant="ghost" color="neutral" :disabled="loading || cart.serverBusy" class="checkout__clear" @click="clearCart">
        Очистить
      </UButton>
    </header>
    <AppShopStatus class="mb-4" />

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
      <div v-if="lastRemoved" class="section__items-head">
            <h2 class="section__title">Ваши товары</h2>
            <UButton v-if="lastRemoved" type="button" icon="i-lucide-undo-2" variant="ghost" color="neutral" class="section__undo" aria-label="Вернуть удалённый товар" @click="undoRemoval">
              <span class="section__undo-label">Вернуть</span>
            </UButton>
          </div>
      <UIcon name="i-lucide-shopping-bag" class="checkout__empty-icon" />
      <h2>Корзина пустая</h2>
      <p>Добавьте свежие продукты из каталога.</p>
      <UButton to="/catalog" size="lg">Перейти в каталог</UButton>
    </div>
    <form v-else class="checkout__layout" novalidate @submit.prevent="submit">
      <fieldset class="checkout__main" :disabled="loading">
        <legend class="sr-only">Товары и данные заказа</legend>
        <section class="section">
          <div class="section__items-head">
            <h2 class="section__title">Ваши товары</h2>
            <UButton v-if="lastRemoved" type="button" icon="i-lucide-undo-2" variant="ghost" color="neutral" class="section__undo" aria-label="Вернуть удалённый товар" @click="undoRemoval">
              <span class="section__undo-label">Вернуть</span>
            </UButton>
          </div>
          <CartItems :disabled="loading" @removed="lastRemoved = $event" />
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
          <div v-if="auth.user?.role === 'USER'" class="recipient-tabs" role="group" aria-label="Кому заказ">
            <button type="button" class="recipient-tabs__item" :class="{ 'recipient-tabs__item--active': recipientMode === 'self' }" :aria-pressed="recipientMode === 'self'" @click="recipientMode = 'self'">Для себя</button>
            <button type="button" class="recipient-tabs__item" :class="{ 'recipient-tabs__item--active': recipientMode === 'other' }" :aria-pressed="recipientMode === 'other'" @click="recipientMode = 'other'">Другому человеку</button>
          </div>

          <div
            v-if="auth.user?.role === 'USER' && recipientMode === 'self' && availablePhones.length"
            class="saved-phone"
          >
            <label class="saved-phone__label" for="checkout-saved-phone">Сохранённый номер</label>
            <select id="checkout-saved-phone" v-model="selectedPhone" class="saved-phone__select" @change="choosePhone">
              <option v-for="item in availablePhones" :key="item.phone" :value="item.phone">
                {{ item.phone }} — {{ phoneSource(item.source) }}
              </option>
              <option value="manual">Ввести другой номер для этого заказа</option>
            </select>
          </div>

          <div class="form__row">
            <UFormField class="form__field" label="Имя" :error="errors.name" data-checkout-field="name" :class="fieldClass('name')">
              <AppTextInput
                v-model="recipient.name"
                autocomplete="name"
                placeholder="Введите имя"
                :aria-invalid="Boolean(errors.name)"
                size="lg"
              />
            </UFormField>

            <UFormField class="form__field" label="Телефон" :error="errors.phone" data-checkout-field="phone" :class="fieldClass('phone')">
              <AppTextInput
                v-model="recipient.phone"
                format="phone"
                type="tel"
                inputmode="tel"
                autocomplete="tel"
                placeholder="+7 (___) ___-__-__"
                :aria-invalid="Boolean(errors.phone)"
                size="lg"
                @update:model-value="onPhoneInput"
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

            <NuxtLink v-if="auth.loggedIn && recipientMode === 'self'" to="/profile" class="section__link">
              Мои адреса
            </NuxtLink>
          </div>

          <div v-if="auth.loggedIn && recipientMode === 'self' && addresses.length" class="addresses">
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
          <UButton
            v-if="recipientMode === 'self' && selectedAddressId !== null && form.type === 'DELIVERY'"
            type="button"
            variant="link"
            class="section__link"
            @click="selectedAddressId = null"
          >
            Изменить адрес для этого заказа
          </UButton>

          <div v-if="showAddressForm" class="address">
            <div class="form__row">
              <UFormField class="form__field" label="Город" :error="errors.city" data-checkout-field="city" :class="fieldClass('city')">
                <AppTextInput v-model="recipient.city" placeholder="Название города" :aria-invalid="Boolean(errors.city)" />
              </UFormField>

              <UFormField class="form__field" label="Улица" :error="errors.street" data-checkout-field="street" :class="fieldClass('street')">
                <AppTextInput
                  v-model="recipient.street"
                  placeholder="Название улицы"
                  :aria-invalid="Boolean(errors.street)"
                />
              </UFormField>
            </div>

            <div class="form__grid">
              <UFormField class="form__field" label="Дом" :error="errors.house" data-checkout-field="house" :class="fieldClass('house')">
                <UInput v-model="recipient.house" placeholder="Номер дома" :aria-invalid="Boolean(errors.house)" />
              </UFormField>

              <UFormField label="Квартира">
                <UInput v-model="recipient.flat" placeholder="Номер квартиры" />
              </UFormField>

              <UFormField label="Подъезд">
                <UInput v-model="recipient.entrance" placeholder="Номер подъезда" />
              </UFormField>

              <UFormField label="Этаж">
                <UInput v-model="recipient.floor" placeholder="Номер этажа" />
              </UFormField>
            </div>

            <UFormField label="Домофон">
              <UInput v-model="recipient.intercom" placeholder="Код домофона" />
            </UFormField>

            <UFormField label="Комментарий курьеру">
              <UTextarea
                v-model="recipient.comment"
                placeholder="Комментарий для курьера"
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
        </section>

        <section v-if="queueOffer?.showScheduledOffer" class="section queue-offer">
          <h2 class="section__title">Сейчас высокая загрузка</h2>
          <p>Вы примерно {{ queueOffer.position }}-й в очереди. Ориентировочное начало сборки через {{ queueOffer.wait?.min }}–{{ queueOffer.wait?.max }} минут.</p>
          <p class="section__hint">{{ queueOffer.slots.length ? 'Можете подождать или выбрать удобное время подготовки.' : 'Свободных слотов сейчас нет, заказ можно оставить в обычной очереди.' }} Время ориентировочное.</p>
          <div class="queue-offer__actions" role="group" aria-label="Время подготовки">
            <UButton type="button" :variant="form.pickupTiming === 'asap' ? 'solid' : 'soft'" @click="form.pickupTiming = 'asap'">Оставить как есть</UButton>
            <UButton type="button" :variant="form.pickupTiming === 'scheduled' ? 'solid' : 'soft'" :disabled="!queueOffer.slots.length" @click="form.pickupTiming = 'scheduled'">Выбрать время</UButton>
          </div>
          <UFormField
            v-if="form.pickupTiming === 'scheduled'" label="Подготовить к (Москва)"
            :error="errors.deliveryAt" class="form__field" data-checkout-field="deliveryAt"
            :class="fieldClass('deliveryAt')" required>
            <select v-model="form.pickupAt" class="queue-offer__select" :aria-invalid="Boolean(errors.deliveryAt)">
              <option value="">Выберите доступное время</option>
              <option v-for="slot in queueOffer.slots" :key="slot.at" :value="slot.at">{{ slotLabel(slot.at) }}</option>
            </select>
          </UFormField>
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
          :disabled="!canSubmit || cart.serverBusy"
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
import type { CartItem, ServerCartSnapshot } from "~/utils/cart";
import type { Address } from "~/types/address";
import type { OrderCreated, OrderType, QueueOffer } from "~/types/order";
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { recipientDefaults, recipientDraft } from "~/utils/checkout-recipient";
import { checkoutErrors, checkoutFieldOrder, type CheckoutField } from "~/utils/checkout-validation";
import type { OrderPhone, OrderPhoneSnapshot } from "~/types/order-phone";
import {
  deliveryEligibility,
  type PublicShopSettings,
} from "~/utils/shop-settings";
const {
  data: settings,
  error: settingsError,
  refresh: refreshSettings,
} = await useApi<PublicShopSettings>("/shop/settings");
const { data: queueOffer, refresh: refreshQueueOffer } = await useApi<QueueOffer>("/orders/queue/offer");

const auth = useAuthStore();
const cart = useCartStore();
const actions = useCartActions();
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

const { data: addressData, refresh: refreshAddresses } = await useApi<Address[]>("/addresses", {
  default: () => [],
  immediate: auth.loggedIn,
});

const { data: phoneData, refresh: refreshPhones } = await useApi<OrderPhoneSnapshot>("/order-phones", {
  immediate: auth.user?.role === "USER",
});
const availablePhones = computed(() => phoneData.value?.phones ?? []);
const selectedPhone = ref("");
const phoneEdited = ref(false);
function phoneSource(source: OrderPhone["source"]) {
  if (source === "ACCOUNT") return "телефон аккаунта";
  if (source === "TELEGRAM") return "подтверждённый Telegram";
  return "добавлен вручную";
}
function choosePhone() {
  phoneEdited.value = true;
  self.phone = selectedPhone.value === "manual" ? "" : selectedPhone.value;
}
function onPhoneInput() {
  if (recipientMode.value !== "self") return;
  phoneEdited.value = true;
  selectedPhone.value = "manual";
}

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
});
const checkoutRequestId = ref<string | null>(null);
const requestQuoteToken = ref<string | null>(null);
watch(() => cart.quote?.token, token => {
  if (requestQuoteToken.value && token !== requestQuoteToken.value) {
    checkoutRequestId.value = null;
    requestQuoteToken.value = null;
  }
});
watch(queueOffer, offer => {
  if (!offer?.showScheduledOffer) { form.pickupTiming = 'asap'; form.pickupAt = ''; }
  else if (form.pickupAt && !offer.slots.some(slot => slot.at === form.pickupAt)) form.pickupAt = '';
});
const slotLabel = (value: string) => new Date(value).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const recipientMode = ref<"self" | "other">("self");
const defaults = recipientDefaults(auth.user, name.value);
const self = reactive(recipientDraft(defaults.name, defaults.phone, "Москва"));
const other = reactive(recipientDraft());
const recipient = computed(() => recipientMode.value === "other" ? other : self);
watch(phoneData, (value) => {
  if (!auth.user || auth.user.role !== "USER" || !value || phoneEdited.value) return;
  self.phone = value.primaryPhone ?? recipientDefaults(auth.user).phone;
  selectedPhone.value = availablePhones.value.some((item) => item.phone === self.phone)
    ? self.phone : "manual";
}, { immediate: true });


watch(name, (value) => {
  if (!auth.loggedIn && !self.name) self.name = value;
});
watch(() => auth.user?.id, (userId) => {
  if (!userId) {
    Object.assign(self, recipientDraft("", "", "Москва"));
    selectedAddressId.value = null;
    selectedPhone.value = "";
    phoneEdited.value = false;
    return;
  }
  const value = recipientDefaults(auth.user);
  self.name = value.name;
  self.phone = value.phone;
  phoneEdited.value = false;
  selectedPhone.value = value.phone;
  void refreshAddresses();
  if (auth.user?.role === "USER") void refreshPhones();
});

const canSubmit = computed(
  () =>
    !loading.value &&
    !cart.serverBusy &&
    (cart.mode === "guest" || cart.serverRevision !== null) &&
    !quotePending.value &&
    ready.value &&
    cart.count > 0 &&
    cart.quote?.valid &&
    (form.type === "DELIVERY"
      ? eligibility.value?.delivery
      : eligibility.value?.pickup),
);
const notice = useHeaderNotice();
const lastRemoved = shallowRef<CartItem | null>(null);
async function undoRemoval() {
  if (!lastRemoved.value || loading.value) return;
  const { product, qty } = lastRemoved.value;
  if (await actions.put(product, qty)) {
    lastRemoved.value = null;
    notice.show({ target: 'cart', text: 'Товар возвращён в корзину' });
  } else {
    notice.show({ target: 'cart', text: 'Не удалось вернуть товар. Проверьте количество и лимит позиций.' });
  }
}
async function clearCart() {
  if (await actions.clear())
    notice.show({ target: 'cart', text: 'Корзина очищена' });
}
async function retryQuote() {
  await Promise.all([refreshQuote(), refreshSettings(), refreshQueueOffer()]);
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
  () => [form.type, form.pickupTiming, recipientMode.value],
  () => {
    clearErrors();
    error.value = "";
  },
);

const showAddressForm = computed(
  () =>
    recipientMode.value === "other" ||
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

  self.city = address.city;
  self.street = address.street;
  self.house = address.house;
  self.flat = address.flat ?? "";
  self.entrance = address.entrance ?? "";
  self.floor = address.floor ?? "";
  self.intercom = address.intercom ?? "";
  self.comment = address.comment ?? "";
}

function manualAddress() {
  selectedAddressId.value = null;

  self.city = "Москва";
  self.street = "";
  self.house = "";
  self.flat = "";
  self.entrance = "";
  self.floor = "";
  self.intercom = "";
  self.comment = "";
}

const shakeFields = ref<CheckoutField[]>([]);
let shakeTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(shakeTimer));

function fieldClass(field: CheckoutField) {
  return {
    "form__field--invalid": Boolean(errors[field]),
    "form__field--shake": shakeFields.value.includes(field),
  };
}

watch(
  () => [recipient.value.name, recipient.value.phone, recipient.value.city,
    recipient.value.street, recipient.value.house, form.pickupAt],
  () => {
    const current = checkoutErrors(recipient.value, form);
    for (const key of checkoutFieldOrder)
      if (errors[key] && !current[key]) errors[key] = "";
  },
);

function validate() {
  const current = checkoutErrors(recipient.value, form);
  Object.assign(errors, current);
  return !Object.values(current).some(Boolean);
}

function clearErrors() {
  for (const key of checkoutFieldOrder) errors[key] = "";
  shakeFields.value = [];
}

async function revealErrors() {
  clearTimeout(shakeTimer);
  shakeFields.value = [];
  await nextTick();
  shakeFields.value = checkoutFieldOrder.filter((field) => Boolean(errors[field]));
  shakeTimer = setTimeout(() => { shakeFields.value = []; }, 350);
  if (typeof document === "undefined") return;
  let field: HTMLElement | null = null;
  for (const key of checkoutFieldOrder) {
    if (!errors[key]) continue;
    const candidate = document.querySelector<HTMLElement>(`[data-checkout-field="${key}"]`);
    if (candidate?.getClientRects().length) {
      field = candidate;
      break;
    }
  }
  if (!field) return;
  const input = field.querySelector<HTMLInputElement>("input, textarea, select");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const scroll = () => field.scrollIntoView({
    behavior: reducedMotion ? "instant" : "smooth",
    block: "center",
  });
  scroll();
  input?.focus({ preventScroll: true });
  requestAnimationFrame(scroll);
  const viewport = window.visualViewport;
  if (viewport) {
    const onResize = () => scroll();
    viewport.addEventListener("resize", onResize, { once: true });
    setTimeout(() => viewport.removeEventListener("resize", onResize), 700);
  }
}

async function submit() {
  if (!canSubmit.value) return;
  if (loading.value) return;
  if (!validate()) {
    if (form.type === "DELIVERY" && !showAddressForm.value &&
      (errors.city || errors.street || errors.house))
      selectedAddressId.value = null;
    await revealErrors();
    return;
  }

  loading.value = true;
  error.value = "";

  if (recipientMode.value === "self") name.value = self.name;
  const rememberName = recipientMode.value === "self" ? rememberOnSuccess() : () => {};
  try {
    const previousToken = cart.quote?.token;
    const requestedType = form.type;
    const requestedTiming = form.pickupTiming;
    const requestedSlot = form.pickupAt;
    const [refreshed] = await Promise.all([refreshQuote(), refreshSettings(), refreshQueueOffer()]);
    if (!refreshed || settingsError.value || !cart.quote?.valid) return;
    if (
      previousToken !== cart.quote.token ||
      requestedType !== form.type ||
      requestedTiming !== form.pickupTiming ||
      requestedSlot !== form.pickupAt ||
      !(form.type === "DELIVERY"
        ? eligibility.value?.delivery
        : eligibility.value?.pickup)
    ) {
      error.value =
        "Условия заказа изменились. Проверьте товары, сумму и способ получения перед оформлением.";
      return;
    }
    const recipientData = recipient.value;
    const body = {
      type: form.type,
      quoteToken: cart.quote.token ?? undefined,
      fulfillmentMode: form.pickupTiming === 'scheduled' ? 'SCHEDULED' : 'ASAP',
      scheduledFor: form.pickupTiming === 'scheduled' ? form.pickupAt : undefined,
      checkoutRequestId: checkoutRequestId.value ?? crypto.randomUUID(),
      customerName: recipientData.name.trim(),
      customerPhone: recipientData.phone.trim(),
      address: form.type === "DELIVERY"
        ? {
            city: recipientData.city.trim(),
            street: recipientData.street.trim(),
            house: recipientData.house.trim(),
            flat: recipientData.flat.trim() || undefined,
            entrance: recipientData.entrance.trim() || undefined,
            floor: recipientData.floor.trim() || undefined,
            intercom: recipientData.intercom.trim() || undefined,
            comment: recipientData.comment.trim() || undefined,
          }
        : undefined,
    };
    checkoutRequestId.value = body.checkoutRequestId;
    requestQuoteToken.value = body.quoteToken ?? null;
    let order: OrderCreated;
    if (cart.mode === "server") {
      const userId = auth.user?.id;
      const revision = cart.serverRevision;
      if (!userId || !revision) return;
      const result = await api<{ order: OrderCreated; cart: ServerCartSnapshot }>(
        "/cart/checkout",
        { method: "POST", body: { ...body, revision } },
      );
      cart.applyServer(result.cart, userId);
      order = result.order;
    } else {
      await api('/orders/checkout-session', { method: 'POST' });
      order = await api<OrderCreated>("/orders", {
        method: "POST",
        body: {
          ...body,
          items: cart.items.map((item) => ({
            productId: item.product.id,
            qty: item.qty,
          })),
        },
      });
      cart.clear();
    }
    rememberName();

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
.saved-phone {
  display: block;
  margin-bottom: 1rem;
}
.saved-phone__label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
}
.saved-phone__select {
  width: 100%;
  min-height: var(--touch-target);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  background: var(--ui-bg);
}
.form__field--invalid :deep(input),
.form__field--invalid :deep(textarea) {
  border-color: var(--ui-error);
}
.form__field--shake {
  animation: checkout-shake 350ms ease-in-out;
}
.form__field {
  scroll-margin-block: 5rem calc(7rem + var(--safe-bottom));
}
@keyframes checkout-shake {
  20%, 60% { transform: translateX(-4px); }
  40%, 80% { transform: translateX(4px); }
}
@media (prefers-reduced-motion: reduce) {
  .form__field--shake { animation: none; }
}

.recipient-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}

.recipient-tabs__item {
  min-height: var(--touch-target);
  padding: 0.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
  text-align: center;
}

.recipient-tabs__item--active {
  border-color: var(--ui-primary);
  background: var(--ui-bg-elevated);
}

.recipient-tabs__item:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.section__items-head {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.25rem;
  margin-bottom: 1.25rem;
}

.section__items-head .section__title {
  margin-bottom: 0;
}

.section__undo {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
  flex-shrink: 0;
  justify-content: center;
}

@media (max-width: 360px) {
  .section__undo-label { display: none; }
}

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

.queue-offer {
  border-color: color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-primary) 7%, var(--ui-bg));
}

.queue-offer__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-block: 0.75rem;
}
.queue-offer__select {
  width: 100%;
  min-height: var(--touch-target);
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  background: var(--ui-bg);
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
