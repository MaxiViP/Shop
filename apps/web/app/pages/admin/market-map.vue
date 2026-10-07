<template>
  <section class="map-admin">
    <header class="map-admin__header">
      <div><h2 class="map-admin__title">Карта рынка</h2><p class="map-admin__muted">Багратионовский рынок · 2 этаж · {{ points.length }} точек</p></div>
      <div class="map-admin__actions">
        <UButton to="/market-map" variant="outline" color="neutral">Публичная карта</UButton>
        <UButton icon="i-lucide-plus" :disabled="busy" @click="choose(null)">Добавить точку</UButton>
      </div>
    </header>
    <UAlert v-if="loadError" color="error" :title="apiError(loadError)" />
    <UAlert v-if="error" color="error" :title="error" />
    <div class="map-admin__layout">
      <div class="map-admin__preview">
        <MarketMap :points="preview" editable :placing="placing && !busy" :selected-id="selected?.id ?? 0" @select="select" @place="place" />
        <p class="map-admin__muted">Скрытые точки приглушены. Номер и фото можно добавить позже. Изменения в preview сохраняются кнопкой «Сохранить».</p>
        <UFormField label="Найти точку в списке">
          <UInput v-model="search" icon="i-lucide-search" class="w-full" maxlength="160" />
        </UFormField>
        <div class="map-admin__list">
          <UButton v-for="point in directory" :key="point.id" color="neutral" :variant="point.id === selected?.id ? 'soft' : 'ghost'" :disabled="busy" @click="choose(point)">
            <UIcon :name="point.isPublished ? 'i-lucide-eye' : 'i-lucide-eye-off'" aria-hidden="true" />{{ marketPointLabel(point) }}
          </UButton>
        </div>
      </div>
      <form class="map-admin__form" @submit.prevent="save">
        <h3 class="map-admin__heading">{{ selected ? 'Редактирование точки' : 'Новая точка' }}</h3>
        <div class="map-admin__row">
          <UFormField label="Название" required><UInput v-model="form.name" :disabled="busy" required maxlength="160" class="w-full" @blur="suggestSlug" /></UFormField>
          <UFormField label="Номер точки" hint="Необязательно · например, Д1"><UInput v-model="form.unitNumber" :disabled="busy" maxlength="40" class="w-full" /></UFormField>
        </div>
        <UFormField label="Адрес страницы (slug)" required hint="Латинские буквы, цифры и дефисы. При изменении старый адрес перестанет работать.">
          <UInput v-model="form.slug" :disabled="busy" required maxlength="180" pattern="[a-z0-9]+(-[a-z0-9]+)*" class="w-full" />
        </UFormField>
        <UFormField label="Тип точки" required><USelect v-model="form.kind" :items="marketKinds" :disabled="busy" class="w-full" /></UFormField>
        <UFormField label="Короткое описание"><UTextarea v-model="form.description" :disabled="busy" :rows="3" maxlength="3000" autoresize class="w-full" /></UFormField>
        <UFormField label="Примерный ассортимент" hint="Общий ориентир. Актуальный выбор покупатель уточняет в чате."><UTextarea v-model="form.sampleAssortment" :disabled="busy" :rows="3" maxlength="2000" autoresize class="w-full" /></UFormField>
        <fieldset class="map-admin__position">
          <legend class="map-admin__heading">Положение на карте</legend>
          <UFormField label="Этаж" hint="Сейчас доступна схема 2 этажа."><UInput :model-value="form.floor" readonly class="w-full" /></UFormField>
          <div class="map-admin__row">
            <UFormField label="По горизонтали, %" required><UInput v-model.number="form.mapX" type="number" required min="0" max="100" step="any" :disabled="busy" class="w-full" /></UFormField>
            <UFormField label="По вертикали, %" required><UInput v-model.number="form.mapY" type="number" required min="0" max="100" step="any" :disabled="busy" class="w-full" /></UFormField>
          </div>
          <UButton :variant="placing ? 'solid' : 'outline'" :disabled="busy" :aria-pressed="placing" icon="i-lucide-mouse-pointer-2" @click="placing = !placing">{{ placing ? 'Выберите место на карте' : 'Указать место на карте' }}</UButton>
          <p class="map-admin__muted">0% — левый верхний край, 100% — правый нижний. Поля координат также доступны с клавиатуры.</p>
        </fieldset>
        <div class="map-admin__row">
          <UFormField label="Порядок в списке"><UInput v-model.number="form.sortOrder" type="number" required min="-1000000" max="1000000" step="1" :disabled="busy" class="w-full" /></UFormField>
          <UFormField label="Публикация"><USwitch v-model="form.isPublished" :disabled="busy" :label="form.isPublished ? 'Показывать покупателям' : 'Скрыта от покупателей'" /></UFormField>
        </div>
        <UButton type="submit" :loading="busy" icon="i-lucide-save">{{ selected ? 'Сохранить' : 'Создать точку' }}</UButton>
        <section class="map-admin__photo" aria-labelledby="map-photo">
          <h3 id="map-photo" class="map-admin__heading">Фото точки</h3>
          <img v-if="selected?.photoUrl" :src="asset(selected.photoUrl)" :alt="selected.name" class="map-admin__image">
          <p class="map-admin__muted">JPEG, PNG, WebP · до 5 МБ и 25 мегапикселей. {{ selected ? 'Фото сохраняется отдельно от формы.' : 'Сначала создайте точку, затем добавьте фото.' }}</p>
          <div class="map-admin__actions">
            <UButton icon="i-lucide-image-plus" variant="outline" :disabled="!selected || busy" @click="picker?.click()">{{ selected?.photoUrl ? 'Заменить фото' : 'Добавить фото' }}</UButton>
            <UButton v-if="selected?.photoUrl" color="error" variant="ghost" :disabled="busy" @click="removePhoto">Удалить фото</UButton>
          </div>
          <input ref="picker" class="map-admin__file" type="file" accept="image/jpeg,image/png,image/webp" :disabled="!selected || busy" aria-label="Фото точки" @change="upload">
        </section>
      </form>
    </div>
    <AdminConfirm v-model:open="confirm" title="Не сохранять изменения?" description="В форме есть изменения. Подтвердите переход к другой точке без сохранения." :busy="busy" @confirm="discard" />
  </section>
</template>

<script setup lang="ts">
import type { MarketPoint, MarketPointInput, MarketMarker } from '~/types/market-map';
import { marketKinds, marketPointLabel } from '~/utils/market-map';
import { productSlug } from '~/utils/slug';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const { data, error: loadError } = await useApi<MarketPoint[]>('/admin/market-map/points', { query: { floor: 2 } });
const api = useApiClient();
const asset = useAsset();
const toast = useToast();
const points = ref<MarketPoint[]>(data.value ?? []);
const selected = ref<MarketPoint | null>(null);
type PointDraft = Omit<MarketPointInput, 'unitNumber' | 'description' | 'sampleAssortment'> & {
  unitNumber: string; description: string; sampleAssortment: string;
};
const defaults = (): PointDraft => ({ name: '', slug: '', unitNumber: '', kind: 'STALL',
  description: '', sampleAssortment: '', floor: 2, mapX: null, mapY: null, isPublished: false, sortOrder: 0 });
const form = reactive<PointDraft>(defaults());
const baseline = ref(JSON.stringify(form));
const busy = ref(false);
const placing = ref(false);
const error = ref('');
const search = ref('');
const picker = ref<HTMLInputElement>();
const confirm = ref(false);
const pendingPoint = ref<MarketPoint | null>(null);
const directory = computed(() => points.value.filter(point => marketPointLabel(point).toLocaleLowerCase('ru-RU').includes(search.value.trim().toLocaleLowerCase('ru-RU'))));
const preview = computed<MarketMarker[]>(() => [
  ...points.value.filter(point => point.id !== selected.value?.id),
  { ...form, name: form.name || 'Новая точка', id: selected.value?.id ?? 0 },
]);
function apply(point: MarketPoint | null) {
  selected.value = point;
  const values = point ? {
    name: point.name, slug: point.slug, unitNumber: point.unitNumber ?? '', kind: point.kind,
    description: point.description ?? '', sampleAssortment: point.sampleAssortment ?? '',
    floor: point.floor, mapX: point.mapX, mapY: point.mapY, isPublished: point.isPublished, sortOrder: point.sortOrder,
  } : defaults();
  Object.assign(form, values);
  baseline.value = JSON.stringify(form);
  placing.value = false;
  error.value = '';
}
function choose(point: MarketPoint | null) {
  if (busy.value || point?.id === selected.value?.id && point !== null) return;
  if (JSON.stringify(form) !== baseline.value) { pendingPoint.value = point; confirm.value = true; return; }
  apply(point);
}
function discard() { apply(pendingPoint.value); confirm.value = false; }
function select(id: number) { const point = points.value.find(item => item.id === id); if (point) choose(point); }
function place(position: { mapX: number; mapY: number }) {
  if (busy.value) return;
  Object.assign(form, position);
  placing.value = false;
}
function suggestSlug() { if (!selected.value && !form.slug) form.slug = productSlug(form.name); }
function store(point: MarketPoint) {
  points.value = [...points.value.filter(item => item.id !== point.id), point]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const point = await api<MarketPoint>(selected.value ? `/admin/market-map/points/${selected.value.id}` : '/admin/market-map/points', {
      method: selected.value ? 'PATCH' : 'POST', body: { ...form },
    });
    store(point); apply(point);
    toast.add({ title: 'Точка сохранена', color: 'success' });
  } catch (cause) { error.value = apiError(cause); }
  finally { busy.value = false; }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !selected.value || busy.value) return;
  if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    error.value = 'Выберите JPEG, PNG или WebP до 5 МБ.'; return;
  }
  const body = new FormData(); body.append('file', file);
  await photoRequest({ method: 'POST', body });
}
async function removePhoto() { await photoRequest({ method: 'DELETE' }); }
async function photoRequest(options: { method: 'POST'; body: FormData } | { method: 'DELETE' }) {
  if (!selected.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const point = await api<MarketPoint>(`/admin/market-map/points/${selected.value.id}/photo`, options);
    store(point);
    selected.value = point;
    toast.add({ title: options.method === 'POST' ? 'Фото сохранено' : 'Фото удалено', color: 'success' });
  } catch (cause) { error.value = apiError(cause); }
  finally { busy.value = false; }
}
</script>

<style scoped>
.map-admin { display: grid; gap: 1rem; min-width: 0; }
.map-admin__header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
.map-admin__title { font-size: var(--section-title); font-weight: 700; }
.map-admin__heading { font-weight: 600; }
.map-admin__muted { font-size: .8125rem; color: var(--ui-text-muted); line-height: 1.5; }
.map-admin__layout { display: grid; gap: 1rem; min-width: 0; }
.map-admin__preview { display: grid; gap: .75rem; align-content: start; min-width: 0; }
.map-admin__form { display: grid; justify-items: stretch; align-content: start; gap: 1rem; min-width: 0; padding: 1rem; border: 1px solid var(--ui-border); border-radius: 1rem; background: var(--ui-bg-elevated); }
.map-admin__form > :deep(button) { justify-self: start; min-height: 44px; }
.map-admin__row { display: grid; gap: .75rem; min-width: 0; }
.map-admin__position { display: grid; justify-items: start; gap: .75rem; min-width: 0; }
.map-admin__position .map-admin__row { width: 100%; }
.map-admin__list { display: grid; gap: .25rem; max-height: 15rem; overflow-y: auto; }
.map-admin__list :deep(button) { justify-content: start; min-height: 44px; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.map-admin__actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.map-admin__photo { display: grid; gap: .75rem; padding-top: 1rem; border-top: 1px solid var(--ui-border); }
.map-admin__image { width: 100%; max-height: 15rem; object-fit: contain; border-radius: .75rem; background: var(--ui-bg); }
.map-admin__file { display: none; }
@media (min-width: 40rem) { .map-admin__row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 64rem) { .map-admin__layout { grid-template-columns: minmax(0, 1.3fr) minmax(22rem, 1fr); } }
</style>
