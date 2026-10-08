<template>
  <section class="map-admin">
    <header class="map-admin__header">
      <div><h2 class="map-admin__title">Карта рынка</h2><p class="map-admin__muted">Багратионовский рынок · {{ floor }} этаж · {{ points.length }} точек</p></div>
      <div class="map-admin__actions">
        <UFormField label="Этаж"><USelect :model-value="floor" :items="floors" :disabled="busy || floorLoading" @update:model-value="requestFloor" /></UFormField>
        <UButton to="/market-map" variant="outline" color="neutral">Публичная карта</UButton>
        <UButton icon="i-lucide-plus" :disabled="busy" @click="choose(null)">Добавить точку</UButton>
      </div>
    </header>
    <UAlert v-if="loadError" color="error" :title="apiError(loadError)" />
    <UAlert v-if="layoutError" color="error" :title="apiError(layoutError)" />
    <UAlert v-if="error" color="error" :title="error" />
    <div class="map-admin__layout">
      <div class="map-admin__preview">
        <div class="map-admin__actions">
          <USwitch v-model="showBounds" label="Показать границы точек" :disabled="busy || floorLoading" />
          <USwitch v-model="editingGeometry" label="Редактировать геометрию" :disabled="busy || floorLoading || !geometry" />
        </div>
        <MarketMap :points="preview" editable :floor="floor" :placing="(placing || placingEscalator) && !busy" :selected-id="selected?.id ?? 0" :editing="editingGeometry" :show-bounds="showBounds" :disabled="busy || floorLoading" :escalator="previewEscalator" @select="select" @place="place" @geometry="changeGeometry" />
        <div class="map-admin__actions">
          <UButton icon="i-lucide-save" :disabled="!dirty || busy || floorLoading" @click="save">Сохранить точку</UButton>
          <UButton variant="outline" color="neutral" :disabled="!dirty || busy" @click="cancelPoint">Отменить</UButton>
          <span v-if="dirty" class="map-admin__dirty" role="status">Есть несохранённые изменения</span>
        </div>
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
      <form class="map-admin__form" :inert="floorLoading" :aria-busy="busy || floorLoading" @submit.prevent="save">
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
          <UFormField label="Этаж"><UInput :model-value="form.floor" readonly class="w-full" /></UFormField>
          <div class="map-admin__row">
            <UFormField label="Координата маркера по горизонтали, %"><UInput v-model.number="form.mapX" type="number" min="0" max="100" step="0.000001" :disabled="busy" class="w-full" /></UFormField>
            <UFormField label="Координата маркера по вертикали, %"><UInput v-model.number="form.mapY" type="number" min="0" max="100" step="0.000001" :disabled="busy" class="w-full" /></UFormField>
          </div>
          <UButton :variant="placing ? 'solid' : 'outline'" :disabled="busy" :aria-pressed="placing" icon="i-lucide-mouse-pointer-2" @click="placing = !placing; placingEscalator = false">{{ placing ? 'Выберите место на карте' : 'Указать место на карте' }}</UButton>
          <UButton v-if="form.mapX !== null && form.mapY !== null" color="neutral" variant="ghost" :disabled="busy" @click="form.mapX = null; form.mapY = null; form.mapWidth = null; form.mapHeight = null">Убрать со схемы</UButton>
          <p class="map-admin__muted">0% — левый верхний край, 100% — правый нижний. Поля координат также доступны с клавиатуры.</p>
        </fieldset>
        <fieldset class="map-admin__position">
          <legend class="map-admin__heading">Интерактивная область</legend>
          <div class="map-admin__row">
            <UFormField label="X"><UInput :model-value="geometry?.x" type="number" step="0.1" :disabled="busy || !geometry" class="w-full" aria-label="X области" @update:model-value="exact('x', $event)" /></UFormField>
            <UFormField label="Y"><UInput :model-value="geometry?.y" type="number" step="0.1" :disabled="busy || !geometry" class="w-full" aria-label="Y области" @update:model-value="exact('y', $event)" /></UFormField>
            <UFormField label="Width"><UInput :model-value="geometry?.width" type="number" min="12" max="1200" step="0.1" :disabled="busy || !geometry" class="w-full" aria-label="Ширина области" @update:model-value="exact('width', $event)" /></UFormField>
            <UFormField label="Height"><UInput :model-value="geometry?.height" type="number" min="12" max="1460" step="0.1" :disabled="busy || !geometry" class="w-full" aria-label="Высота области" @update:model-value="exact('height', $event)" /></UFormField>
          </div>
          <p class="map-admin__muted">X/Y — левый верхний угол области в координатах SVG 1200 × 1460. Включите редактирование, выберите точку и тяните область или один из восьми маркеров. Масштаб не меняет сохраняемые координаты.</p>
        </fieldset>
        <fieldset class="map-admin__position">
          <legend class="map-admin__heading">Оформление точки</legend>
          <div class="map-admin__color">
            <input type="color" class="map-admin__picker" :value="marketPointColor(form)" :disabled="busy" aria-label="Цвет заливки точки" @input="pickColor">
            <UInput :model-value="form.mapColor ?? ''" placeholder="Стандартный цвет" maxlength="7" aria-label="HEX-цвет точки" :disabled="busy" @update:model-value="form.mapColor = $event ? String($event) : null" />
            <UButton type="button" color="neutral" variant="ghost" :disabled="busy" @click="form.mapColor = null">Сбросить цвет</UButton>
          </div>
          <USwitch v-model="form.isOurPoint" label="Наша точка" :disabled="busy || ['ENTRY', 'SERVICE'].includes(form.kind) && !form.isOurPoint" />
          <UFormField v-if="form.isOurPoint" label="Подпись" hint="По умолчанию: Мы здесь!"><UInput v-model="form.ourLabel" maxlength="80" placeholder="Мы здесь!" :disabled="busy" class="w-full" /></UFormField>
          <p v-if="form.isOurPoint" class="map-admin__muted">После сохранения эта точка станет единственной основной нашей точкой на данном этаже. Ранее назначенная точка сохранит остальные настройки.</p>
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
    <section class="map-admin__landmark" :inert="floorLoading" :aria-busy="busy || floorLoading">
      <h3 class="map-admin__heading">Эскалатор · {{ floor }} этаж</h3>
      <p class="map-admin__muted">Положение длинного эскалатора задаёт администратор. До публикации используется исходный ориентир схемы, без дублирования.</p>
      <UButton v-if="!escalatorDraft" type="button" icon="i-lucide-plus" variant="outline" :disabled="busy" @click="addEscalator">Настроить длинный эскалатор</UButton>
      <template v-else>
        <div class="map-admin__row">
          <UFormField label="X эскалатора"><UInput v-model.number="escalatorDraft.x" type="number" min="0" max="1200" step="0.1" class="w-full" :disabled="busy" /></UFormField>
          <UFormField label="Y эскалатора"><UInput v-model.number="escalatorDraft.y" type="number" min="0" max="1460" step="0.1" class="w-full" :disabled="busy" /></UFormField>
          <UFormField label="Длина"><UInput v-model.number="escalatorDraft.length" type="number" min="60" max="1460" step="1" class="w-full" :disabled="busy" /></UFormField>
          <UFormField label="Ширина"><UInput v-model.number="escalatorDraft.width" type="number" min="24" max="1200" step="1" class="w-full" :disabled="busy" /></UFormField>
          <UFormField label="Поворот, °"><UInput v-model.number="escalatorDraft.rotation" type="number" min="0" max="359" step="1" class="w-full" :disabled="busy" /></UFormField>
        </div>
        <USwitch v-model="escalatorDraft.published" label="Показывать эскалатор покупателям" :disabled="busy" />
        <div class="map-admin__actions">
          <UButton type="button" icon="i-lucide-mouse-pointer-2" :variant="placingEscalator ? 'solid' : 'outline'" :disabled="busy" @click="placingEscalator = !placingEscalator; placing = false">Указать место эскалатора</UButton>
          <UButton type="button" variant="ghost" color="neutral" :disabled="busy" @click="escalatorDraft = null">Сбросить ориентир</UButton>
        </div>
        <p v-if="!previewEscalator" class="map-admin__muted">Укажите корректные положение, длину и ширину перед сохранением.</p>
      </template>
      <div v-if="layoutDirty" class="map-admin__actions">
        <UButton type="button" :loading="busy" :disabled="!!escalatorDraft && !previewEscalator" icon="i-lucide-save" @click="saveEscalator">Сохранить эскалатор</UButton>
        <UButton type="button" :disabled="busy" color="neutral" variant="outline" @click="cancelLayout">Отменить эскалатор</UButton>
        <span class="map-admin__dirty" role="status">Ориентир не сохранён</span>
      </div>
    </section>
    <AdminConfirm v-model:open="confirm" title="Не сохранять изменения?" description="Есть несохранённые изменения. Подтвердите продолжение без сохранения." :busy="busy" @confirm="discard" />
  </section>
</template>

<script setup lang="ts">
import type { MarketPoint, MarketPointInput, MarketMarker, MarketLayout } from '~/types/market-map';
import { marketKinds, marketPointLabel, marketPointColor, hitRect, rectPosition, adjustRect, escalatorBounds, mapSize, minHitSize } from '~/utils/market-map';
import type { MapRect, MapGeometry, Escalator } from '~/utils/market-map';
import { productSlug } from '~/utils/slug';

definePageMeta({ middleware: 'admin', layout: 'admin' });
const { data, error: loadError } = await useApi<MarketPoint[]>('/admin/market-map/points', { query: { floor: 2 } });
const { data: initialLayout, error: layoutError } = await useApi<MarketLayout>('/admin/market-map/layouts/2');
const api = useApiClient(), asset = useAsset(), toast = useToast();
const points = ref<MarketPoint[]>(data.value ?? []), selected = ref<MarketPoint | null>(null), floor = ref(2);
const floors = Array.from({ length: 20 }, (_, index) => ({ value: index + 1, label: (index + 1) + ' этаж' }));
type PointDraft = Omit<MarketPointInput, 'unitNumber' | 'description' | 'sampleAssortment' | 'ourLabel'> & { unitNumber: string; description: string; sampleAssortment: string; ourLabel: string };
const defaults = (): PointDraft => ({ name: '', slug: '', unitNumber: '', kind: 'STALL', description: '', sampleAssortment: '', floor: floor.value,
  mapX: null, mapY: null, mapWidth: null, mapHeight: null, mapColor: null, isOurPoint: false, ourLabel: '', isPublished: false, sortOrder: 0 });
const form = reactive<PointDraft>(defaults());
const baseline = ref(JSON.stringify(form)), version = ref<string | undefined>();
const busy = ref(false), placing = ref(false), placingEscalator = ref(false), editingGeometry = ref(false), showBounds = ref(false);
const error = ref(''), search = ref(''), picker = ref<HTMLInputElement>();
const confirm = ref(false), floorLoading = ref(false);
type Pending = { type: 'point'; point: MarketPoint | null } | { type: 'floor'; floor: number } | { type: 'reset' } | { type: 'leave'; resolve: (allow: boolean) => void };
let pending: Pending | undefined, generation = 0, controller: AbortController | undefined;
const dirty = computed(() => JSON.stringify(form) !== baseline.value);
type EscalatorDraft = Omit<Escalator, 'x' | 'y'> & { x: number | null; y: number | null };
const layout = ref<MarketLayout>(initialLayout.value ?? { floor: 2, escalator: null, updatedAt: null });
const escalatorDraft = ref<EscalatorDraft | null>(layout.value.escalator ? { ...layout.value.escalator } : null);
const layoutBaseline = ref(JSON.stringify(escalatorDraft.value));
const layoutDirty = computed(() => JSON.stringify(escalatorDraft.value) !== layoutBaseline.value);
const geometry = computed(() => hitRect(form));
const directory = computed(() => points.value.filter(point => marketPointLabel(point).toLocaleLowerCase('ru-RU').includes(search.value.trim().toLocaleLowerCase('ru-RU'))));
const otherPreview = computed(() => points.value.filter(point => point.id !== selected.value?.id).map(point =>
  form.isOurPoint && point.floor === form.floor && point.isOurPoint ? { ...point, isOurPoint: false } : point));
const preview = computed<MarketMarker[]>(() => [...otherPreview.value, { ...form, name: form.name || 'Новая точка', id: selected.value?.id ?? 0 }]);
const previewEscalator = computed<Escalator | null>(() => {
  const draft = escalatorDraft.value;
  if (!draft || draft.x === null || draft.y === null || ![draft.x, draft.y, draft.width, draft.length, draft.rotation].every(Number.isFinite) || draft.width < 24 || draft.length < 60) return null;
  const value = { ...draft, x: draft.x, y: draft.y }, bounds = escalatorBounds(value);
  return bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= mapSize.width && bounds.y + bounds.height <= mapSize.height ? value : null;
});
function draftFrom(point: MarketPoint): PointDraft {
  return { name: point.name, slug: point.slug, unitNumber: point.unitNumber ?? '', kind: point.kind,
    description: point.description ?? '', sampleAssortment: point.sampleAssortment ?? '', floor: point.floor,
    mapX: point.mapX, mapY: point.mapY, mapWidth: point.mapWidth ?? null, mapHeight: point.mapHeight ?? null,
    mapColor: point.mapColor ?? null, isOurPoint: point.isOurPoint ?? false, ourLabel: point.ourLabel ?? '', isPublished: point.isPublished, sortOrder: point.sortOrder };
}
function apply(point: MarketPoint | null) {
  selected.value = point; Object.assign(form, point ? draftFrom(point) : defaults());
  baseline.value = JSON.stringify(form); version.value = point?.updatedAt; placing.value = false; editingGeometry.value = false; error.value = '';
}
function requestDiscard(action: Pending) { pending = action; confirm.value = true; }
function choose(point: MarketPoint | null) {
  if (busy.value || floorLoading.value || point?.id === selected.value?.id && point !== null) return;
  if (dirty.value) { requestDiscard({ type: 'point', point }); return; }
  apply(point);
}
function discard() {
  const action = pending; pending = undefined; confirm.value = false;
  if (!action) return;
  if (action.type === 'point') apply(action.point);
  else if (action.type === 'floor') void loadFloor(action.floor);
  else if (action.type === 'leave') action.resolve(true);
  else apply(selected.value);
}
watch(confirm, value => { if (!value && pending) { if (pending.type === 'leave') pending.resolve(false); pending = undefined; } });
onBeforeRouteLeave(() => {
  if (!dirty.value && !layoutDirty.value) return true;
  if (busy.value || floorLoading.value) return false;
  return new Promise<boolean>(resolve => requestDiscard({ type: 'leave', resolve }));
});
onBeforeUnmount(() => { generation++; controller?.abort(); if (pending?.type === 'leave') pending.resolve(false); });
function cancelPoint() { if (!busy.value) requestDiscard({ type: 'reset' }); }
function requestFloor(value: unknown) {
  const next = Number(value); if (!Number.isInteger(next) || next < 1 || next > 20 || next === floor.value) return;
  if (dirty.value || layoutDirty.value) requestDiscard({ type: 'floor', floor: next }); else void loadFloor(next);
}
async function loadFloor(next: number) {
  const current = ++generation; controller?.abort(); controller = new AbortController(); floorLoading.value = true; error.value = '';
  try {
    const [rows, sheet] = await Promise.all([api<MarketPoint[]>('/admin/market-map/points', { query: { floor: next }, signal: controller.signal }),
      api<MarketLayout>('/admin/market-map/layouts/' + next, { signal: controller.signal })]);
    if (current !== generation) return;
    floor.value = next; points.value = rows; layout.value = sheet; apply(null);
    escalatorDraft.value = sheet.escalator ? { ...sheet.escalator } : null; layoutBaseline.value = JSON.stringify(escalatorDraft.value); placingEscalator.value = false;
  } catch (cause: unknown) { if (current === generation) error.value = apiError(cause); }
  finally { if (current === generation) floorLoading.value = false; }
}
function select(id: number) { const point = points.value.find(item => item.id === id); if (point) choose(point); }
function changeGeometry(position: MapGeometry) { if (!busy.value) Object.assign(form, position); }
function exact(field: keyof MapRect, value: unknown) {
  const current = geometry.value, number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!current || !Number.isFinite(number)) return;
  const dimension = field === 'width' ? Math.max(minHitSize, Math.min(mapSize.width, number))
    : field === 'height' ? Math.max(minHitSize, Math.min(mapSize.height, number)) : number;
  Object.assign(form, rectPosition(adjustRect({ ...current, [field]: dimension }, 0, 0)));
}
function place(position: { mapX: number; mapY: number }) {
  if (busy.value) return;
  if (placingEscalator.value && escalatorDraft.value) {
    const draft = escalatorDraft.value, bounds = escalatorBounds({ ...draft, x: 0, y: 0 });
    const centerX = Math.max(bounds.width / 2, Math.min(mapSize.width - bounds.width / 2, position.mapX * mapSize.width / 100));
    const centerY = Math.max(bounds.height / 2, Math.min(mapSize.height - bounds.height / 2, position.mapY * mapSize.height / 100));
    draft.x = Math.round((centerX - draft.width / 2) * 1e6) / 1e6; draft.y = Math.round((centerY - draft.length / 2) * 1e6) / 1e6; placingEscalator.value = false;
  } else { Object.assign(form, position); placing.value = false; }
}
function pickColor(event: Event) { form.mapColor = (event.target as HTMLInputElement).value.toUpperCase(); }
function suggestSlug() { if (!selected.value && !form.slug) form.slug = productSlug(form.name); }
function store(point: MarketPoint) {
  points.value = [...points.value.filter(item => item.id !== point.id).map(item => point.isOurPoint && item.floor === point.floor ? { ...item, isOurPoint: false } : item), point]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}
async function save() {
  if (busy.value || floorLoading.value) return;
  busy.value = true; error.value = '';
  try {
    const point = await api<MarketPoint>(selected.value ? `/admin/market-map/points/${selected.value.id}` : '/admin/market-map/points', {
      method: selected.value ? 'PATCH' : 'POST', body: { ...form, ...(selected.value && version.value ? { expectedUpdatedAt: version.value } : {}) },
    });
    const released = point.isOurPoint && points.value.some(row => row.id !== point.id && row.floor === point.floor && row.isOurPoint);
    store(point); apply(point);
    if (released) {
      // The transaction also advances the former primary point's revision.
      try {
        points.value = await api<MarketPoint[]>('/admin/market-map/points', { query: { floor: floor.value } });
        apply(points.value.find(row => row.id === point.id) ?? point);
      } catch { error.value = 'Точка сохранена, но список не удалось обновить. Обновите страницу перед редактированием другой точки.'; }
    }
    toast.add({ title: 'Точка сохранена', color: 'success' });
  } catch (cause: unknown) { error.value = apiError(cause); }
  finally { busy.value = false; }
}
function addEscalator() { escalatorDraft.value = { x: null, y: null, width: 56, length: 300, rotation: 0, published: false }; }
function cancelLayout() { if (!busy.value) { escalatorDraft.value = layout.value.escalator ? { ...layout.value.escalator } : null; layoutBaseline.value = JSON.stringify(escalatorDraft.value); placingEscalator.value = false; } }
async function saveEscalator() {
  if (busy.value || floorLoading.value || escalatorDraft.value && !previewEscalator.value) return;
  busy.value = true; error.value = '';
  try {
    const value = await api<MarketLayout>('/admin/market-map/layouts/' + floor.value, { method: 'PATCH', body: { escalator: previewEscalator.value, expectedUpdatedAt: layout.value.updatedAt } });
    layout.value = value; cancelLayoutAfterSave(value); toast.add({ title: 'Эскалатор сохранён', color: 'success' });
  } catch (cause: unknown) { error.value = apiError(cause); }
  finally { busy.value = false; }
}
function cancelLayoutAfterSave(value: MarketLayout) { escalatorDraft.value = value.escalator ? { ...value.escalator } : null; layoutBaseline.value = JSON.stringify(escalatorDraft.value); placingEscalator.value = false; }
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file || !selected.value || busy.value) return;
  if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { error.value = 'Выберите JPEG, PNG или WebP до 5 МБ.'; return; }
  const body = new FormData(); body.append('file', file); await photoRequest({ method: 'POST', body });
}
async function removePhoto() { await photoRequest({ method: 'DELETE' }); }
async function photoRequest(options: { method: 'POST'; body: FormData } | { method: 'DELETE' }) {
  if (!selected.value || busy.value) return;
  const previous = selected.value, changed = dirty.value; busy.value = true; error.value = '';
  try {
    const point = await api<MarketPoint>(`/admin/market-map/points/${previous.id}/photo`, options);
    store(point); selected.value = point;
    if (!changed) apply(point);
    else if (JSON.stringify(draftFrom(previous)) === JSON.stringify(draftFrom(point))) version.value = point.updatedAt;
    else error.value = 'Данные точки изменены. Отмените черновик и загрузите актуальные данные перед сохранением.';
    toast.add({ title: options.method === 'POST' ? 'Фото сохранено' : 'Фото удалено', color: 'success' });
  } catch (cause: unknown) { error.value = apiError(cause); }
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
.map-admin__dirty { align-self: center; color: var(--ui-warning); font-size: .8125rem; }
.map-admin__color { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.map-admin__picker { width: 44px; height: 44px; padding: .2rem; border: 1px solid var(--ui-border); border-radius: .5rem; cursor: pointer; }
.map-admin__landmark { display: grid; gap: .75rem; padding: 1rem; border: 1px solid var(--ui-border); border-radius: 1rem; }
@media (min-width: 40rem) { .map-admin__row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 64rem) { .map-admin__layout { grid-template-columns: minmax(0, 1.3fr) minmax(22rem, 1fr); } }
</style>
