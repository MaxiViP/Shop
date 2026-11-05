<template>
  <div class="delivery-map">
    <p class="delivery-map__hint">Найдите адрес через поиск на карте или нажмите на нужный дом.</p>
    <div ref="element" class="delivery-map__canvas" aria-label="Выбор адреса доставки на Яндекс Картах" />
    <p v-if="pending" role="status">Определяем адрес…</p>
    <p v-if="error" class="delivery-map__error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { loadDeliveryMap, type DeliveryMap, type MapAddress, type MapMarker } from '~/utils/yandex-map';
import type { DeliveryAddress } from '~/types/delivery-estimate';
const props = defineProps<{ address?: DeliveryAddress | null }>();
const emit = defineEmits<{ picked: [address: DeliveryAddress] }>();
const config = useRuntimeConfig();
const element = ref<HTMLElement | null>(null);
const pending = ref(true);
const error = ref('');
let map: DeliveryMap | undefined;
let marker: MapMarker | undefined;
let disposed = false;
let sequence = 0;

function choose(result: MapAddress) {
  const city = result.getLocalities()[0] ?? result.getAdministrativeAreas()[0];
  const street = result.getThoroughfare();
  const house = result.getPremiseNumber();
  if (!city || !street || !house) throw new Error('Выберите конкретный дом или заполните адрес вручную.');
  const [lat, lng] = result.geometry.getCoordinates();
  marker?.geometry.setCoordinates([lat, lng]);
  void map?.setCenter([lat, lng], 16);
  emit('picked', { city, street, house, lat, lng });
}

onMounted(async () => {
  try {
    const maps = await loadDeliveryMap(config.public.yandexMapsKey, config.public.yandexSuggestKey);
    if (disposed || !element.value) return;
    const center: [number, number] = props.address?.lat != null && props.address.lng != null
      ? [props.address.lat, props.address.lng] : [55.7558, 37.6176];
    map = new maps.Map(element.value, { center, zoom: 11, controls: ['zoomControl', 'searchControl'] }, { searchControlProvider: 'yandex#map' });
    marker = new maps.Placemark(center, {}, { preset: 'islands#greenDotIcon' });
    map.geoObjects.add(marker);
    map.events.add('click', event => {
      const coords = event.get('coords');
      if (!Array.isArray(coords) || coords.length !== 2 || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') return;
      const version = ++sequence;
      pending.value = true;
      error.value = '';
      void Promise.resolve(maps.geocode([coords[0], coords[1]], { results: 1, kind: 'house' }))
        .then(result => {
          if (disposed || version !== sequence) return;
          const address = result.geoObjects.get(0);
          if (!address) throw new Error('Адрес не найден. Выберите дом или введите адрес вручную.');
          choose(address);
        }).catch(() => {
          if (!disposed && version === sequence) error.value = 'Не удалось определить дом. Выберите другой дом или заполните адрес вручную.';
        }).finally(() => { if (!disposed && version === sequence) pending.value = false; });
    });
    const search = map.controls.get('searchControl');
    search.events.add('resultselect', event => {
      const index = event.get('index');
      if (typeof index !== 'number') return;
      const version = ++sequence;
      pending.value = true;
      error.value = '';
      void Promise.resolve(search.getResult(index)).then(result => {
        if (!disposed && version === sequence) choose(result);
      }).catch(() => {
        if (!disposed && version === sequence) error.value = 'Выберите конкретный дом или заполните адрес вручную.';
      }).finally(() => { if (!disposed && version === sequence) pending.value = false; });
    });
  } catch {
    if (!disposed) error.value = 'Карта временно недоступна. Адрес можно ввести вручную.';
  } finally {
    if (!disposed) pending.value = false;
  }
});
onBeforeUnmount(() => { disposed = true; ++sequence; map?.destroy(); });
</script>

<style scoped>
.delivery-map { display: grid; min-width: 0; gap: 0.75rem; }
.delivery-map__canvas { height: 20rem; width: 100%; overflow: hidden; border-radius: 0.75rem; }
.delivery-map__hint { color: var(--ui-text-muted); font-size: 0.875rem; }
.delivery-map__error { color: var(--ui-error); }
</style>
