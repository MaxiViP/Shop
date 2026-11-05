<template>
  <div class="delivery-map" @keydown.enter.stop.prevent @submit.stop.prevent>
    <p class="delivery-map__hint">Найдите дом через поиск, нажмите на карту или заполните адрес вручную.</p>
    <div ref="element" class="delivery-map__canvas" aria-label="Выбор адреса доставки на Яндекс Картах" :aria-busy="pending" />
    <p v-if="pending" role="status">Определяем адрес…</p>
    <p v-if="hint" class="delivery-map__hint" role="status">{{ hint }}</p>
    <p v-if="error" class="delivery-map__error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { loadDeliveryMap, type Coordinates, type DeliveryMap, type MapAddress, type MapMarker, type YandexMaps } from '~/utils/yandex-map';
import { deliveryAddressKey } from '~/utils/delivery-estimate';
import { formatAddress } from '~/utils/address';
import { splitYandexHouse } from '~/utils/yandex-house';
import type { DeliveryAddress } from '~/types/delivery-estimate';

const props = defineProps<{ address?: DeliveryAddress | null }>();
const emit = defineEmits<{ picked: [address: DeliveryAddress] }>();
const config = useRuntimeConfig();
const element = ref<HTMLElement | null>(null);
const pending = ref(true);
const error = ref('');
const hint = ref('');
let maps: YandexMaps | undefined;
let map: DeliveryMap | undefined;
let marker: MapMarker | undefined;
let disposed = false;
let sequence = 0;
let addressTimer: ReturnType<typeof setTimeout> | undefined;
let cancelLookup: (() => void) | undefined;

function cancel() {
  ++sequence;
  clearTimeout(addressTimer);
  cancelLookup?.();
  cancelLookup = undefined;
  pending.value = false;
}

function clearMarker() {
  if (marker) map?.geoObjects.remove(marker);
  marker = undefined;
}

function show(coordinates: Coordinates, zoom = 16) {
  if (!maps || !map) return;
  if (marker) marker.geometry.setCoordinates(coordinates);
  else {
    marker = new maps.Placemark(coordinates, {}, { preset: 'islands#greenDotIcon' });
    map.geoObjects.add(marker);
  }
  void Promise.resolve(map.setCenter(coordinates, zoom)).catch(() => {});
}

async function locate(request: () => PromiseLike<MapAddress | undefined>, manual = false) {
  cancel();
  const version = sequence;
  pending.value = true;
  error.value = '';
  hint.value = '';
  clearMarker();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<MapAddress | undefined>((resolve, reject) => {
      cancelLookup = () => reject(new Error('Поиск отменён'));
      timer = setTimeout(() => reject(new Error('Время поиска истекло')), 10_000);
      // Both synchronous API failures and rejected Yandex promises reach the same handler.
      void Promise.resolve().then(request).then(resolve, reject);
    });
    if (disposed || version !== sequence) return;
    if (!result) throw new Error('Адрес не найден');
    const city = result.getLocalities()[0] ?? result.getAdministrativeAreas()[0];
    const street = result.getThoroughfare();
    const number = result.getPremiseNumber();
    const coordinates = result.geometry.getCoordinates();
    if (!coordinates.every(Number.isFinite)) throw new Error('Координаты не найдены');
    if (!city || !street || !number) {
      if (manual) throw new Error('Дом не найден');
      void Promise.resolve(map?.setCenter(coordinates, street ? 14 : 11)).catch(() => {});
      hint.value = 'Место показано на карте. Уточните номер дома в поиске или заполните адрес вручную.';
      return;
    }
    // A nearby house must never silently stand in for a manually entered address.
    if (manual && result.properties.get('metaDataProperty.GeocoderMetaData.precision') !== 'exact')
      throw new Error('Точный дом не найден');
    show(coordinates);
    if (!manual) {
      const [lat, lng] = coordinates;
      emit('picked', { city, street, ...splitYandexHouse(number), lat, lng });
    }
  } catch {
    if (!disposed && version === sequence)
      error.value = 'Не удалось найти точный дом. Проверьте адрес или выберите дом на карте. Ручной ввод остаётся доступен.';
  } finally {
    clearTimeout(timer);
    if (!disposed && version === sequence) {
      cancelLookup = undefined;
      pending.value = false;
    }
  }
}

function syncAddress(immediate = false) {
  cancel();
  if (!maps || !map) return;
  error.value = '';
  hint.value = '';
  clearMarker();
  const address = props.address;
  if (!address?.city.trim() || !address.street.trim() || !address.house.trim()) return;
  if (address.lat != null && address.lng != null && Number.isFinite(address.lat) && Number.isFinite(address.lng)) {
    show([address.lat, address.lng]);
    return;
  }
  const query = formatAddress(address, false);
  const lookup = () => {
    const api = maps;
    if (api) void locate(async () => (await api.geocode(query, { results: 1 })).geoObjects.get(0), true);
  };
  if (immediate) lookup();
  else addressTimer = setTimeout(lookup, 600);
}

watch(() => deliveryAddressKey(props.address ?? null), () => syncAddress(), { flush: 'sync' });

onMounted(async () => {
  try {
    maps = await loadDeliveryMap(config.public.yandexMapsKey, config.public.yandexSuggestKey);
    if (disposed || !element.value) return;
    map = new maps.Map(element.value, {
      center: [55.7558, 37.6176], zoom: 11, controls: ['zoomControl', 'searchControl'],
    }, {
      searchControlProvider: 'yandex#map', searchControlNoPlacemark: true,
      searchControlNoCentering: true, searchControlUseMapBounds: true,
    });
    const api = maps;
    map.events.add('click', event => {
      const coords = event.get('coords');
      if (!Array.isArray(coords) || coords.length !== 2 || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') return;
      void locate(async () => (await api.geocode([coords[0], coords[1]], { results: 1, kind: 'house' })).geoObjects.get(0));
    });
    const search = map.controls.get('searchControl');
    search.events.add('submit', () => { cancel(); error.value = ''; hint.value = ''; });
    search.events.add('resultselect', event => {
      const index = event.get('index');
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
      void locate(async () => search.getResultsArray()[index] ?? await search.getResult(index));
    });
    search.events.add('error', () => {
      cancel();
      error.value = 'Поиск временно недоступен. Адрес можно ввести вручную.';
    });
    syncAddress(true);
  } catch {
    if (!disposed) {
      pending.value = false;
      error.value = 'Карта временно недоступна. Адрес можно ввести вручную.';
    }
  }
});

onBeforeUnmount(() => { disposed = true; cancel(); map?.destroy(); });
</script>

<style scoped>
.delivery-map { display: grid; min-width: 0; gap: 0.75rem; }
.delivery-map__canvas { height: 20rem; width: 100%; overflow: hidden; border-radius: 0.75rem; }
.delivery-map__hint { color: var(--ui-text-muted); font-size: 0.875rem; }
.delivery-map__error { color: var(--ui-error); }
</style>
