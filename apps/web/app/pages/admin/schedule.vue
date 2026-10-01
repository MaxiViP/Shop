<template>
  <section class="space-y-6">
    <header><h2 class="text-2xl font-semibold">Режим работы рынка</h2><p class="text-muted">Часовой пояс: Europe/Moscow</p></header>
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <template v-if="data">
      <UCard>
        <UBadge :color="data.status.isOpen ? 'success' : 'neutral'">{{ data.status.isOpen ? 'Сейчас рынок открыт' : 'Сейчас рынок закрыт' }}</UBadge>
        <p class="mt-2">Сегодня: {{ data.status.openTime && data.status.closeTime ? `${data.status.openTime}–${data.status.closeTime}` : 'закрыто' }}</p>
      </UCard>
      <UCard>
        <template #header><h3 class="font-semibold">Недельное расписание</h3></template>
        <div v-for="row in weekly" :key="row.weekday" class="grid grid-cols-[minmax(90px,1fr)_auto] gap-2 border-b border-default py-3 sm:grid-cols-[minmax(110px,1fr)_auto_auto_auto_auto] sm:items-center">
          <strong>{{ weekdays[row.weekday - 1] }}</strong>
          <USwitch v-model="row.enabled" :aria-label="`${weekdays[row.weekday - 1]}: открыт`" />
          <UInput :model-value="clock(row.openMinutes)" type="time" :disabled="!row.enabled" aria-label="Открытие" @update:model-value="row.openMinutes = minutes(String($event))" />
          <UInput :model-value="clock(row.closeMinutes)" type="time" :disabled="!row.enabled" aria-label="Закрытие" @update:model-value="row.closeMinutes = minutes(String($event))" />
          <UButton size="sm" :loading="busy" @click="saveWeekday(row)">Сохранить</UButton>
        </div>
      </UCard>
      <UCard>
        <template #header><div class="flex items-center gap-3"><h3 class="font-semibold mr-auto">Особые дни</h3><UButton icon="i-lucide-plus" @click="newException">Добавить день</UButton></div></template>
        <div v-for="row in data.exceptions" :key="row.id" class="flex flex-wrap items-center gap-3 border-b border-default py-3">
          <strong>{{ row.date.slice(0, 10) }}</strong>
          <span>{{ row.closed ? 'Закрыто' : `${clock(row.openMinutes!)}–${clock(row.closeMinutes!)}` }}</span>
          <span class="text-muted mr-auto">{{ row.note }}</span>
          <UButton variant="outline" size="sm" @click="editException(row)">Изменить</UButton>
          <UButton color="error" variant="ghost" size="sm" @click="selected = row; confirm = true">Удалить</UButton>
        </div>
        <form v-if="editing" class="mt-5 grid gap-3 sm:grid-cols-2" @submit.prevent="saveException">
          <UFormField label="Дата"><UInput v-model="exception.date" type="date" required /></UFormField>
          <UFormField label="Тип дня"><USelect v-model="kind" :items="kinds" /></UFormField>
          <UFormField v-if="kind !== 'closed'" label="Открытие"><UInput v-model="exception.open" type="time" required /></UFormField>
          <UFormField v-if="kind !== 'closed'" label="Закрытие"><UInput v-model="exception.close" type="time" required /></UFormField>
          <UFormField label="Комментарий"><UInput v-model="exception.note" maxlength="160" /></UFormField>
          <div class="flex items-end gap-2"><UButton type="submit" :loading="busy">Сохранить</UButton><UButton variant="outline" @click="editing = false">Отмена</UButton></div>
        </form>
      </UCard>
    </template>
    <AdminConfirm v-model:open="confirm" title="Удалить особый день?" description="Это изменит доступность оформления заказов на выбранную дату." :busy="busy" @confirm="deleteException" />
  </section>
</template>
<script setup lang="ts">
import type { ScheduleData, ShopHours, ShopHoursException } from '~/types/admin-ops';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const { data, error, refresh } = await useApi<ScheduleData>('/admin/schedule');
const api = useApiClient(); const toast = useToast();
const busy = ref(false);
const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const weekly = ref<ShopHours[]>([]);
watch(data, value => { weekly.value = value?.weekly.map(row => ({ ...row })) ?? []; }, { immediate: true });
const clock = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const minutes = (value: string) => { const [hour = 0, minute = 0] = value.split(':').map(Number); return hour * 60 + minute; };
async function saveWeekday(row: ShopHours) {
  if (busy.value || row.openMinutes >= row.closeMinutes) return;
  busy.value = true;
  try { await api(`/admin/schedule/weekly/${row.weekday}`, { method: 'PATCH', body: {
    enabled: row.enabled, openMinutes: row.openMinutes, closeMinutes: row.closeMinutes,
  } }); await refresh(); toast.add({ title: 'График сохранён' }); }
  catch (cause) { toast.add({ title: apiError(cause), color: 'error' }); }
  finally { busy.value = false; }
}
const editing = ref(false); const editingId = ref<number | null>(null);
const kind = ref('regular');
const kinds = [{ label: 'Обычный день', value: 'regular' }, { label: 'Сокращённый день', value: 'short' }, { label: 'Закрыто', value: 'closed' }];
const exception = reactive({ date: '', open: '09:00', close: '21:00', note: '' });
function newException() { editingId.value = null; kind.value = 'regular'; Object.assign(exception, { date: '', open: '09:00', close: '21:00', note: '' }); editing.value = true; }
function editException(row: ShopHoursException) {
  editingId.value = row.id; kind.value = row.closed ? 'closed' : 'short';
  Object.assign(exception, { date: row.date.slice(0, 10), open: clock(row.openMinutes ?? 540),
    close: clock(row.closeMinutes ?? 1260), note: row.note ?? '' }); editing.value = true;
}
watch(kind, value => { if (value === 'short' && !editingId.value) exception.close = '17:00'; if (value === 'regular' && !editingId.value) exception.close = '21:00'; });
async function saveException() {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(editingId.value ? `/admin/schedule/exceptions/${editingId.value}` : '/admin/schedule/exceptions', {
      method: editingId.value ? 'PATCH' : 'POST', body: {
        date: exception.date, closed: kind.value === 'closed',
        openMinutes: kind.value === 'closed' ? null : minutes(exception.open),
        closeMinutes: kind.value === 'closed' ? null : minutes(exception.close),
        note: exception.note.trim() || null,
      },
    });
    editing.value = false; await refresh(); toast.add({ title: 'Особый день сохранён' });
  } catch (cause) { toast.add({ title: apiError(cause), color: 'error' }); }
  finally { busy.value = false; }
}
const selected = ref<ShopHoursException | null>(null); const confirm = ref(false);
async function deleteException() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  try { await api(`/admin/schedule/exceptions/${selected.value.id}`, { method: 'DELETE' });
    confirm.value = false; await refresh(); toast.add({ title: 'Особый день удалён' }); }
  catch (cause) { toast.add({ title: apiError(cause), color: 'error' }); }
  finally { busy.value = false; }
}
</script>
