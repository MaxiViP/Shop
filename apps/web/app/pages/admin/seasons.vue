<template>
  <section class="seasons">
    <h2 class="text-2xl font-semibold">Сезонность</h2>
    <p class="text-muted">Календарные шаблоны повторяются каждый год по Москве. Оба месяца входят в сезон. Начало позже окончания означает период через Новый год. Шаблоны назначаются только выбранным товарам.</p>
    <UCard>
      <div class="seasons__row"><h3 class="text-xl font-semibold">Готовые календарные шаблоны</h3><UButton icon="i-lucide-calendar-plus" :loading="busy" @click="addPresets">Добавить недостающие шаблоны</UButton></div>
      <p class="text-sm text-muted">{{ presets?.length ?? 0 }} ориентиров для московских рынков, российских регионов и Подмосковья. Существующие месяцы, названия, описания и активность сохраняются. Товары автоматически не назначаются.</p>
      <div class="seasons__catalog">
        <div v-for="group in seasonGroups" :key="group.value"><h4 class="font-semibold">{{ group.label }}</h4><ul><li v-for="preset in presets?.filter(item => item.group === group.value)" :key="preset.key">{{ preset.name }} · {{ months[preset.startMonth - 1]?.label }} — {{ months[preset.endMonth - 1]?.label }}</li></ul></div>
      </div>
      <p class="text-sm text-muted">Для тепличной, импортной и местной продукции проверяйте происхождение партии и при необходимости изменяйте календарь.</p>
    </UCard>
    <UAlert v-if="templatesError" color="error" :title="apiError(templatesError)" :actions="[{ label: 'Повторить', onClick: () => refreshTemplates() }]" />
    <form class="seasons__form" @submit.prevent="saveTemplate">
      <UFormField label="Название шаблона" required><UInput v-model="name" required maxlength="160" :disabled="busy" class="w-full" /></UFormField>
      <UFormField label="Описание"><UTextarea v-model="description" maxlength="1000" :disabled="busy" class="w-full" /></UFormField>
      <UFormField label="Группа"><USelect v-model="templateGroup" :items="groupItems" :disabled="busy" class="w-full" /></UFormField>
      <UFormField label="Месяц начала"><USelect v-model="startMonth" :items="months" :disabled="busy" class="w-full" /></UFormField>
      <UFormField label="Месяц окончания"><USelect v-model="endMonth" :items="months" :disabled="busy" class="w-full" /></UFormField>
      <USwitch v-model="templateActive" label="Шаблон включён" :disabled="busy" />
      <div class="seasons__actions"><UButton type="submit" :loading="busy">{{ editingId ? 'Сохранить шаблон' : 'Создать шаблон' }}</UButton><UButton v-if="editingId" variant="ghost" :disabled="busy" @click="editTemplate()">Отменить</UButton></div>
    </form>
    <p v-if="!templates?.length">Шаблонов пока нет.</p>
    <UInput v-model="templateSearch" icon="i-lucide-search" placeholder="Найти шаблон по названию или группе" class="w-full" />
    <div class="seasons__templates">
      <section v-for="group in groupedTemplates" :key="group.value" class="seasons__templates">
        <h3 class="font-semibold">{{ group.label }}</h3>
      <UCard v-for="template in group.items" :key="template.id">
        <div class="seasons__row">
          <div class="seasons__info"><h4 class="font-semibold">{{ template.name }}</h4><p class="text-sm text-muted">{{ months[template.startMonth - 1]?.label }} — {{ months[template.endMonth - 1]?.label }}</p><p v-if="template.description" class="text-sm text-muted">{{ template.description }}</p></div>
          <UButton variant="ghost" icon="i-lucide-list-filter" @click="showProducts(template.id)">Товаров: {{ template._count.products }}</UButton>
          <UBadge :color="template.active ? 'success' : 'neutral'">{{ template.active ? 'Включён' : 'Отключён' }}</UBadge>
          <UButton variant="outline" :disabled="busy" @click="editTemplate(template)">Редактировать</UButton>
          <UButton variant="ghost" color="neutral" :disabled="busy" @click="toggleTemplate(template)">{{ template.active ? 'Отключить' : 'Включить' }}</UButton>
        </div>
      </UCard>
      </section>
    </div>
    <h3 class="text-xl font-semibold">Назначить сезонность товарам</h3>
    <p v-if="query.seasonTemplateId" class="seasons__row">Связанные товары: {{ templates?.find(item => item.id === query.seasonTemplateId)?.name }}<UButton variant="ghost" @click="showProducts()">Показать все товары</UButton></p>
    <form class="seasons__filters" @submit.prevent="apply">
      <UFormField label="Товар"><UInput v-model="search" maxlength="160" class="w-full" /></UFormField>
      <UFormField label="Категория"><USelect v-model="category" :items="categoryItems" class="w-full" /></UFormField>
      <UButton type="submit" variant="outline">Найти</UButton>
    </form>
    <UAlert v-if="productsError" color="error" :title="apiError(productsError)" />
    <p v-if="pending">Загрузка…</p>
    <div v-else class="seasons__products">
      <label v-for="product in products?.items" :key="product.id" class="seasons__product">
        <UCheckbox :model-value="selected.some(item => item.id === product.id)" :disabled="busy" :aria-label="`Выбрать ${product.name}`" @update:model-value="select(product, $event === true)" />
        <span class="seasons__info"><span class="font-medium">{{ product.name }}</span><span class="seasons__description">{{ product.category.name }} · {{ modes.find(mode => mode.value === product.seasonalMode)?.label }}{{ product.seasonTemplate ? ` · ${product.seasonTemplate.name}` : '' }}</span></span>
      </label>
      <p v-if="!products?.items.length">Товары не найдены.</p>
    </div>
    <UPagination v-if="products && products.total > query.limit" v-model:page="query.page" :total="products.total" :items-per-page="query.limit" :sibling-count="0" />
    <p role="status">Выбрано товаров: {{ selected.length }} из максимум 100. Выбор сохраняется при переходе между страницами.</p>
    <div v-if="selected.length" class="seasons__selection"><UButton v-for="product in selected" :key="product.id" variant="soft" size="sm" icon="i-lucide-x" :disabled="busy" :aria-label="`Убрать ${product.name} из выбора`" @click="select(product, false)">{{ product.name }}</UButton></div>
    <div class="seasons__assignment">
      <UFormField label="Режим"><USelect v-model="mode" :items="modes" :disabled="busy" class="w-full" /></UFormField>
      <UFormField label="Шаблон" :required="mode === 'AUTO'"><USelectMenu v-model="templateId" :items="templateItems" value-key="value" :disabled="busy" :search-input="{ placeholder: 'Поиск шаблона' }" class="w-full" /></UFormField>
      <UButton :disabled="busy || !selected.length || (mode === 'AUTO' && !templateId)" @click="confirmation = true">Проверить назначение</UButton>
    </div>
    <UModal v-model:open="confirmation" title="Назначить сезонность выбранным товарам?" description="Изменения затронут только перечисленные товары.">
      <template #body>
        <p class="font-semibold">{{ modes.find(item => item.value === mode)?.label }}{{ templateId ? ` · ${templates?.find(item => item.id === templateId)?.name}` : '' }}</p>
        <ul class="seasons__confirm"><li v-for="product in selected" :key="product.id">{{ product.name }} · ID {{ product.id }}</li></ul>
        <div class="seasons__actions"><UButton :loading="busy" @click="assign">Подтвердить для {{ selected.length }} товаров</UButton><UButton variant="outline" :disabled="busy" @click="confirmation = false">Отмена</UButton></div>
      </template>
    </UModal>
  </section>
</template>

<script setup lang="ts">
import type { AdminCategory, AdminPage, AdminProduct } from '~/types/admin';
import type { SeasonGroup, SeasonPreset, SeasonalMode, SeasonTemplate } from '~/types/badges';
import { seasonGroups, seasonGroupLabel } from '~/utils/badges';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const { data: templates, error: templatesError, refresh: refreshTemplates } = await useApi<SeasonTemplate[]>('/admin/seasons');
const { data: presets } = await useApi<SeasonPreset[]>('/admin/seasons/presets', { default: () => [] });
const { data: categories } = await useApi<AdminCategory[]>('/admin/categories');
const query = reactive({ page: 1, limit: 20, search: '', category: undefined as number | undefined, seasonTemplateId: undefined as number | undefined });
const { data: products, pending, error: productsError, refresh: refreshProducts } = await useApi<AdminPage<AdminProduct>>('/admin/products', { query });
const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'].map((label, index) => ({ label, value: index + 1 }));
const modes = [{ label: 'Автоматически по шаблону', value: 'AUTO' }, { label: 'Вручную включить', value: 'MANUAL' }, { label: 'Выключить', value: 'OFF' }];
const editingId = ref<number>();
const name = ref('');
const description = ref('');
const templateGroup = ref<SeasonGroup | 'OTHER'>('OTHER');
const templateSearch = ref('');
const groupItems = [...seasonGroups, { label: 'Другие шаблоны', value: 'OTHER' as const }];
const groupedTemplates = computed(() => groupItems.map(group => ({ ...group, items: (templates.value ?? []).filter(template =>
  (template.group ?? 'OTHER') === group.value && `${template.name} ${template.description ?? ''} ${group.label}`.toLocaleLowerCase('ru-RU').includes(templateSearch.value.trim().toLocaleLowerCase('ru-RU')),
  ) })).filter(group => group.items.length));
const startMonth = ref(1);
const endMonth = ref(12);
const templateActive = ref(true);
const search = ref('');
const category = ref(0);
const selected = ref<AdminProduct[]>([]);
const mode = ref<SeasonalMode>('AUTO');
const templateId = ref(0);
const confirmation = ref(false);
const categoryItems = computed(() => [{ label: 'Все категории', value: 0 }, ...(categories.value ?? []).map(item => ({ label: item.name, value: item.id }))]);
const templateItems = computed(() => [{ label: 'Без шаблона', value: 0 }, ...(templates.value ?? []).map(item => ({ label: `${item.name} · ${seasonGroupLabel(item.group)}${item.active ? '' : ' (отключён)'}`, value: item.id }))]);
const api = useApiClient();
const toast = useToast();
const busy = ref(false);
function editTemplate(template?: SeasonTemplate) {
  editingId.value = template?.id;
  name.value = template?.name ?? '';
  description.value = template?.description ?? '';
  templateGroup.value = template?.group ?? 'OTHER';
  startMonth.value = template?.startMonth ?? 1;
  endMonth.value = template?.endMonth ?? 12;
  templateActive.value = template?.active ?? true;
}
async function saveTemplate() {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(editingId.value ? `/admin/seasons/${editingId.value}` : '/admin/seasons', { method: editingId.value ? 'PATCH' : 'POST',
      body: { name: name.value.trim(), description: description.value.trim() || null, group: templateGroup.value === 'OTHER' ? null : templateGroup.value,
        startMonth: startMonth.value, endMonth: endMonth.value, active: templateActive.value } });
    editTemplate(); await refreshTemplates();
    toast.add({ title: 'Шаблон сохранён', color: 'success' });
  } catch (value) { toast.add({ title: apiError(value), color: 'error' }); }
  finally { busy.value = false; }
}
async function toggleTemplate(template: SeasonTemplate) {
  if (busy.value) return;
  busy.value = true;
  try { await api(`/admin/seasons/${template.id}`, { method: 'PATCH', body: { active: !template.active } }); await refreshTemplates(); }
  catch (value) { toast.add({ title: apiError(value), color: 'error' }); }
  finally { busy.value = false; }
}
async function addPresets() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await api<{ created: number }>('/admin/seasons/presets', { method: 'POST' });
    await refreshTemplates(); toast.add({ title: `Добавлено шаблонов: ${result.created}. Существующие настройки сохранены.`, color: 'success' });
  } catch (value) { toast.add({ title: apiError(value), color: 'error' }); }
  finally { busy.value = false; }
}
function showProducts(id?: number) { query.page = 1; query.seasonTemplateId = id; }
function apply() { Object.assign(query, { page: 1, search: search.value, category: category.value || undefined }); }
function select(product: AdminProduct, checked: boolean) {
  selected.value = selected.value.filter(item => item.id !== product.id);
  if (checked && selected.value.length < 100) selected.value.push(product);
}
async function assign() {
  if (busy.value || !confirmation.value || !selected.value.length) return;
  busy.value = true;
  try {
    await api('/admin/seasons/assign', { method: 'POST', body: {
      ids: selected.value.map(product => product.id), seasonalMode: mode.value, seasonTemplateId: templateId.value || null,
    } });
    confirmation.value = false; selected.value = [];
    await Promise.all([refreshProducts(), refreshTemplates()]);
    toast.add({ title: 'Сезонность назначена', color: 'success' });
  } catch (value) { toast.add({ title: apiError(value), color: 'error' }); }
  finally { busy.value = false; }
}
</script>

<style scoped>
.seasons { display: grid; gap: 1rem; min-width: 0; }
.seasons__form, .seasons__filters, .seasons__assignment { display: grid; gap: 0.75rem; align-items: end; min-width: 0; }
.seasons__actions, .seasons__row, .seasons__selection { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
.seasons__templates, .seasons__products { display: grid; gap: 0.5rem; }
.seasons__catalog { display: grid; gap: 1rem; margin-block: 1rem; }
@media (min-width: 48rem) { .seasons__catalog { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.seasons__info { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.seasons__product { display: flex; gap: 0.75rem; align-items: center; padding: 0.75rem; border: 1px solid var(--ui-border); border-radius: 0.5rem; cursor: pointer; }
.seasons__description { display: block; margin-top: 0.25rem; color: var(--ui-text-muted); font-size: 0.8125rem; }
.seasons__confirm { margin-block: 1rem; padding-left: 1.25rem; list-style: disc; overflow-wrap: anywhere; }
.seasons__selection :deep(button) { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
@media (min-width: 48rem) { .seasons__form { grid-template-columns: repeat(3, minmax(0, 1fr)); } .seasons__filters, .seasons__assignment { grid-template-columns: 1fr 1fr auto; } }
</style>
