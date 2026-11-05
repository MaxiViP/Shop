<template>
  <section class="calculator" aria-label="Предварительный расчёт доставки">
    <p class="calculator__intro">Узнайте стоимость доставки с рынка до выбора продуктов. Регистрация не нужна.</p>
    <div v-if="delivery.addresses.length" class="calculator__addresses" aria-label="Сохранённые адреса">
      <button
        v-for="address in delivery.addresses" :key="address.id" type="button"
        class="calculator__address" :aria-pressed="delivery.selected?.id === address.id"
        @click="delivery.select(address)">
        <strong>{{ address.label }}</strong>
        <span>{{ formatAddress(address, false) }}</span>
      </button>
    </div>
    <p v-if="delivery.addressError" role="status">{{ delivery.addressError }} <UButton variant="link" @click="delivery.loadAddresses()">Повторить</UButton></p>
    <form class="calculator__form" @submit.prevent="calculate">
      <div class="calculator__fields">
        <UFormField label="Город" required><UInput v-model="form.city" class="w-full" autocomplete="address-level2" maxlength="100" required /></UFormField>
        <UFormField label="Улица" required><UInput v-model="form.street" class="w-full" maxlength="150" placeholder="Название улицы" required /></UFormField>
        <UFormField label="Дом" required><UInput v-model="form.house" class="w-full" maxlength="30" placeholder="Номер дома" required /></UFormField>
        <UFormField label="Корпус / строение"><UInput v-model="form.buildingPart" class="w-full" maxlength="50" placeholder="При наличии" /></UFormField>
      </div>
      <div class="calculator__actions">
        <UButton type="submit" icon="i-lucide-truck" :disabled="!valid" :loading="delivery.pending">Рассчитать доставку</UButton>
        <UButton v-if="mapsKey" type="button" variant="soft" icon="i-lucide-map-pin" @click="mapOpen = !mapOpen">{{ mapOpen ? 'Скрыть карту' : 'Выбрать на карте' }}</UButton>
      </div>
    </form>
    <LazyDeliveryMap v-if="mapOpen && mapsKey" :address="mapAddress" @picked="pick" />
    <div class="calculator__result">
      <p v-if="delivery.selected" class="calculator__destination">{{ formatAddress(delivery.selected, false) }}</p>
      <DeliveryEstimate :free="free" />
    </div>
    <UButton v-if="delivery.selected" to="/catalog" variant="soft" trailing-icon="i-lucide-arrow-right">Выбрать продукты</UButton>
  </section>
</template>

<script setup lang="ts">
import { useDeliveryStore } from '~/stores/delivery';
import { useCartStore } from '~/stores/cart';
import type { DeliveryAddress } from '~/types/delivery-estimate';
import { formatAddress } from '~/utils/address';
const delivery = useDeliveryStore();
const cart = useCartStore();
const mapsKey = useRuntimeConfig().public.yandexMapsKey;
const mapOpen = ref(false);
const form = reactive({ city: 'Москва', street: '', house: '', buildingPart: '' });
const valid = computed(() => !!(form.city.trim() && form.street.trim() && form.house.trim()));
const free = computed(() => cart.quoteReady && cart.quote?.valid && cart.quote.delivery?.eligible === true);
const formKey = () => JSON.stringify([form.city.trim(), form.street.trim(), form.house.trim(), form.buildingPart.trim()]);
const selectedMatches = computed(() => {
  const current = delivery.selected;
  return !!current && JSON.stringify([current.city.trim(), current.street.trim(), current.house.trim(),
    current.buildingPart?.trim() ?? '']) === formKey();
});
const mapAddress = computed<DeliveryAddress>(() => ({
  ...form, ...(selectedMatches.value ? { lat: delivery.selected?.lat, lng: delivery.selected?.lng } : {}),
}));
watch(() => delivery.selected, address => {
  form.city = address?.city ?? 'Москва';
  form.street = address?.street ?? '';
  form.house = address?.house ?? '';
  form.buildingPart = address?.buildingPart ?? '';
}, { immediate: true });
function calculate() {
  if (!valid.value) return;
  const current = delivery.selected;
  delivery.select(selectedMatches.value && current ? current : {
    city: form.city.trim(), street: form.street.trim(), house: form.house.trim(), buildingPart: form.buildingPart.trim(),
  });
  if (delivery.error) void delivery.refresh(true);
}
function pick(address: DeliveryAddress) { delivery.select(address); }
</script>

<style scoped>
.calculator { display: grid; gap: 1.25rem; min-width: 0; max-width: 52rem; }
.calculator__intro { color: var(--ui-text-muted); line-height: 1.5; }
.calculator__addresses { display: flex; gap: 0.5rem; overflow-x: auto; padding: 0.25rem; }
.calculator__address { display: grid; flex: 0 0 14rem; gap: 0.25rem; min-height: 44px; border: 1px solid var(--ui-border); border-radius: 0.75rem; padding: 0.75rem; text-align: left; cursor: pointer; }
.calculator__address span { color: var(--ui-text-muted); font-size: 0.875rem; }
.calculator__address[aria-pressed="true"] { border-color: var(--ui-primary); background: var(--ui-bg-elevated); }
.calculator__address:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.calculator__form { display: grid; gap: 1rem; }
.calculator__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.calculator__fields > * { min-width: 0; }
.calculator__actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
.calculator__actions :deep(button) { min-height: 44px; }
.calculator__result { display: grid; gap: 0.75rem; padding: 1rem; border: 1px solid var(--ui-border); border-radius: 1rem; background: var(--ui-bg-elevated); }
.calculator__destination { font-size: 0.875rem; overflow-wrap: anywhere; }
@media (min-width: 48rem) { .calculator__fields { grid-template-columns: 1fr 2fr 0.75fr 1fr; } }
</style>
