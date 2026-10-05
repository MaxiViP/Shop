<template>
  <section class="load">
    <header>
      <h2 class="text-2xl font-semibold">Очередь и нагрузка</h2>
      <p class="text-muted">Настройте сборку под обычные дни, выходные и праздники. Время указано по Москве.</p>
    </header>
    <UAlert v-if="error || loadError" color="error" title="Не удалось загрузить нагрузку">
      <template #actions><UButton variant="outline" @click="reload">Повторить</UButton></template>
    </UAlert>
    <template v-if="state">
      <div class="load__metrics">
        <UCard v-for="metric in metrics" :key="metric.label">
          <p class="text-sm text-muted">{{ metric.label }}</p>
          <p class="text-xl font-semibold">{{ metric.value }}</p>
        </UCard>
      </div>
      <p class="load__effective" role="status">
        Сейчас действует {{ state.peakModeActive ? 'пиковый' : 'обычный' }} профиль:
        {{ state.effective.assemblyConcurrency }} сборщ., {{ state.effective.assemblyMinutes }} мин. на заказ,
        высокая очередь от {{ state.effective.queueThreshold }} заказов,
        {{ state.effective.slotCapacity }} заказов на время с интервалом {{ state.effective.slotIntervalMinutes }} мин.
      </p>
      <div class="load__overview">
        <UCard>
          <template #header><h3 class="font-semibold">Ближайшие заказы ко времени</h3></template>
          <ul v-if="state.upcoming.length" class="load__list">
            <li v-for="order in state.upcoming" :key="order.id">
              <NuxtLink :to="`/staff/orders/${order.id}`" class="text-primary">Заказ №{{ order.id }}</NuxtLink>
              <span>{{ dayTime(order.scheduledFor) }}</span>
            </li>
          </ul>
          <p v-else class="text-muted">Пока нет назначенных заказов.</p>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Запись на ближайшее время</h3></template>
          <ul v-if="state.slots.length" class="load__list">
            <li v-for="slot in state.slots" :key="slot.at">
              <span>{{ dayTime(slot.at) }}</span>
              <span :class="{ 'text-warning': slot.reserved >= slot.capacity }">{{ slot.reserved }} / {{ slot.capacity }} занято</span>
            </li>
          </ul>
          <p v-else class="text-muted">В ближайшем графике нет доступного времени.</p>
        </UCard>
      </div>
    </template>
    <form v-if="form" class="load__form" @submit.prevent="save">
      <div class="load__profiles">
        <UCard v-for="profile in profiles" :key="profile.key">
          <template #header><h3 class="font-semibold">{{ profile.label }}</h3></template>
          <fieldset :disabled="busy" class="load__fields">
            <UFormField v-for="field in fields" :key="field.key" :label="field.label" required>
              <UInput v-model.number="form[profile.key][field.key]" type="number" :min="field.min" :max="field.max" step="1" required class="w-full" />
            </UFormField>
          </fieldset>
        </UCard>
      </div>
      <p class="text-muted">Укажите реальное число одновременно работающих сборщиков и среднюю длительность заказа. Эти значения используются в оценке ожидания и времени начала сборки.</p>
      <UCard>
        <template #header><h3 class="font-semibold">Период повышенного спроса</h3></template>
        <div class="load__fields">
          <USwitch v-model="form.peakModeEnabled" label="Запланировать пиковый режим" :disabled="busy" />
          <p v-if="data?.peakModeEnabled" class="text-muted">
            {{ state?.peakModeActive ? 'Пиковый режим активен.' : peakEnded ? 'Период завершён. Действует обычный режим.' : 'Пиковый режим ожидает начала периода.' }}
          </p>
          <div class="load__period">
            <UFormField label="Начало периода (Москва)" :required="form.peakModeEnabled">
              <UInput v-model="form.peakModeStart" type="datetime-local" :disabled="busy" :required="form.peakModeEnabled" class="w-full" />
            </UFormField>
            <UFormField label="Окончание периода (Москва)" :required="form.peakModeEnabled">
              <UInput v-model="form.peakModeEnd" type="datetime-local" :disabled="busy" :required="form.peakModeEnabled" class="w-full" />
            </UFormField>
          </div>
          <p class="text-muted">Пиковый профиль включится в указанное время и автоматически сменится обычным после окончания. Принятые заказы сохранят своё назначенное время.</p>
          <UFormField label="Интервал записи заказов ко времени, мин." required>
            <select v-model.number="form.slotIntervalMinutes" class="load__select" :disabled="busy">
              <option :value="15">15 минут</option><option :value="30">30 минут</option><option :value="60">60 минут</option>
            </select>
          </UFormField>
          <p class="text-muted">Интервал общий для обоих режимов. Вместимость определяется профилем, действующим на выбранное время.</p>
        </div>
      </UCard>
      <UButton type="submit" :loading="busy">Сохранить нагрузку</UButton>
    </form>
    <p v-else-if="pending">Загрузка…</p>
  </section>
</template>

<script setup lang="ts">
import { pickupDate } from '~/utils/pickup';
definePageMeta({ layout: 'admin', middleware: 'admin' });
type Profile = { assemblyConcurrency: number; assemblyMinutes: number; queueThreshold: number; slotCapacity: number };
type LoadSettings = {
  assemblyConcurrency: number; assemblyFallbackMinutes: number; queueThreshold: number; slotCapacity: number;
  peakAssemblyConcurrency: number | null; peakAssemblyMinutes: number | null;
  peakQueueThreshold: number | null; peakSlotCapacity: number | null;
  peakModeEnabled: boolean; peakModeStart: string | null; peakModeEnd: string | null; slotIntervalMinutes: number;
};
type LoadForm = { normal: Profile; peak: Profile; peakModeEnabled: boolean;
  peakModeStart: string; peakModeEnd: string; slotIntervalMinutes: number };
type LoadState = {
  queueLength: number; assembling: number; peakModeActive: boolean;
  effective: Profile & { mode: 'NORMAL' | 'PEAK'; slotIntervalMinutes: number };
  upcoming: { id: number; scheduledFor: string; status: string; type: string }[];
  slots: { at: string; reserved: number; capacity: number }[];
};
const { data, pending, error, refresh } = await useApi<LoadSettings>('/admin/settings');
const { data: state, error: loadError, refresh: refreshLoad } = await useApi<LoadState>('/admin/settings/queue');
const form = ref<LoadForm>();
const moscowInput = (value: string | null) => value ? new Date(Date.parse(value) + 3 * 3600_000).toISOString().slice(0, 16) : '';
watch(data, value => {
  if (!value) return;
  const normal = { assemblyConcurrency: value.assemblyConcurrency, assemblyMinutes: value.assemblyFallbackMinutes,
    queueThreshold: value.queueThreshold, slotCapacity: value.slotCapacity };
  form.value = { normal, peak: {
    assemblyConcurrency: value.peakAssemblyConcurrency ?? normal.assemblyConcurrency,
    assemblyMinutes: value.peakAssemblyMinutes ?? normal.assemblyMinutes,
    queueThreshold: value.peakQueueThreshold ?? normal.queueThreshold,
    slotCapacity: value.peakSlotCapacity ?? normal.slotCapacity,
  }, peakModeEnabled: value.peakModeEnabled, peakModeStart: moscowInput(value.peakModeStart),
  peakModeEnd: moscowInput(value.peakModeEnd), slotIntervalMinutes: value.slotIntervalMinutes };
}, { immediate: true });
const profiles = [{ key: 'normal', label: 'Обычный режим' }, { key: 'peak', label: 'Пиковый режим' }] as const;
const fields = [
  { key: 'assemblyConcurrency', label: 'Одновременно работающих сборщиков', min: 1, max: 30 },
  { key: 'assemblyMinutes', label: 'Среднее время одной сборки, мин.', min: 5, max: 180 },
  { key: 'queueThreshold', label: 'Высокая очередь — от этого числа заказов', min: 1, max: 100 },
  { key: 'slotCapacity', label: 'Заказов на одно назначенное время', min: 1, max: 30 },
] as const;
const metrics = computed(() => state.value ? [
  { label: 'В очереди сейчас', value: state.value.queueLength },
  { label: 'Заказов на сборке', value: state.value.assembling },
  { label: 'Действующий режим', value: state.value.peakModeActive ? 'Пиковый' : 'Обычный' },
  { label: 'Среднее время сборки', value: `${state.value.effective.assemblyMinutes} мин.` },
] : []);
const peakEnded = computed(() => data.value?.peakModeEnd && Date.parse(data.value.peakModeEnd) <= Date.now());
const dayTime = (value: string) => new Date(value).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const busy = ref(false);
const api = useApiClient();
const toast = useToast();
async function reload() { await Promise.all([refresh(), refreshLoad()]); }
async function save() {
  const value = form.value;
  if (!value || busy.value) return;
  const start = pickupDate(value.peakModeStart);
  const end = pickupDate(value.peakModeEnd);
  if (profiles.some(profile => fields.some(field => !Number.isInteger(value[profile.key][field.key]) ||
    value[profile.key][field.key] < field.min || value[profile.key][field.key] > field.max))) {
    toast.add({ title: 'Проверьте значения в обоих профилях нагрузки', color: 'error' }); return;
  }
  if (value.peakModeEnabled && (!start || !end || end <= start)) {
    toast.add({ title: 'Укажите начало и окончание пикового периода', color: 'error' }); return;
  }
  busy.value = true;
  try {
    await api('/admin/settings', { method: 'PATCH', body: {
      assemblyConcurrency: value.normal.assemblyConcurrency, assemblyFallbackMinutes: value.normal.assemblyMinutes,
      queueThreshold: value.normal.queueThreshold, slotCapacity: value.normal.slotCapacity,
      peakAssemblyConcurrency: value.peak.assemblyConcurrency, peakAssemblyMinutes: value.peak.assemblyMinutes,
      peakQueueThreshold: value.peak.queueThreshold, peakSlotCapacity: value.peak.slotCapacity,
      peakModeEnabled: value.peakModeEnabled, peakModeStart: start?.toISOString() ?? null,
      peakModeEnd: end?.toISOString() ?? null, slotIntervalMinutes: value.slotIntervalMinutes,
    } });
    await reload();
    toast.add({ title: 'Профили нагрузки сохранены' });
  } catch (cause) { toast.add({ title: apiError(cause), color: 'error' }); }
  finally { busy.value = false; }
}
useOrderPolling(refreshLoad, () => 30000);
</script>

<style scoped>
.load { display: grid; gap: 1.5rem; min-width: 0; }
.load__metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
.load__overview, .load__profiles, .load__period { display: grid; gap: 1rem; grid-template-columns: minmax(0, 1fr); }
.load__effective { padding: 1rem; border-radius: 0.75rem; background: var(--ui-bg-elevated); line-height: 1.6; }
.load__form, .load__fields { display: grid; gap: 1rem; min-width: 0; }
.load__list { display: grid; gap: 0.75rem; }
.load__list li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem; font-size: 0.875rem; }
.load__select { width: 100%; min-height: var(--touch-target); padding: 0.5rem; border: 1px solid var(--ui-border); border-radius: 0.5rem; background: var(--ui-bg); }
@media (min-width: 48rem) {
  .load__metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .load__overview, .load__profiles, .load__period { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
