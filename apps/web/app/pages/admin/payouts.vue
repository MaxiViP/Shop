<template>
  <section class="space-y-6">
    <header class="flex flex-wrap items-center gap-3"><h2 class="text-2xl font-semibold mr-auto">Выплаты партнёрам</h2><UButton to="/admin/finance" variant="outline">К отчёту</UButton></header>
    <UAlert color="info" title="Выплаты сохраняются как события. Для исправления добавьте корректирующую запись с отрицательной суммой." />
    <div class="grid gap-4 lg:grid-cols-2">
      <UCard v-for="(name, index) in report?.partnerNames ?? ['Партнёр 1', 'Партнёр 2']" :key="index">
        <h3 class="font-semibold">{{ name }} · текущий месяц</h3>
        <p>Начислено: {{ money(index === 0 ? report?.partner1Share ?? 0 : report?.partner2Share ?? 0) }}</p>
        <p>Выплачено: {{ money(paid(index + 1)) }}</p>
        <p class="font-semibold">Остаток: {{ money((index === 0 ? report?.partner1Share ?? 0 : report?.partner2Share ?? 0) - paid(index + 1)) }}</p>
      </UCard>
    </div>
    <UCard>
      <template #header><h3 class="font-semibold">Записать выплату</h3></template>
      <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="save">
        <UFormField label="Партнёр"><USelect v-model="partner" :items="partnerOptions" /></UFormField>
        <UFormField label="Сумма, ₽"><UInput v-model="amount" inputmode="decimal" placeholder="17250" required /></UFormField>
        <UFormField label="Период от"><UInput v-model="periodFrom" type="date" required /></UFormField>
        <UFormField label="Период до"><UInput v-model="periodTo" type="date" required /></UFormField>
        <UFormField label="Выплачено"><UInput v-model="paidAt" type="datetime-local" required /></UFormField>
        <UFormField label="Комментарий"><UInput v-model="comment" maxlength="500" /></UFormField>
        <UButton type="submit" :loading="busy" class="w-fit">Сохранить событие</UButton>
      </form>
    </UCard>
    <UCard>
      <template #header><h3 class="font-semibold">История выплат</h3></template>
      <p v-if="error" class="text-error">{{ apiError(error) }}</p>
      <div v-for="entry in payouts ?? []" :key="entry.id" class="border-b border-default py-3 text-sm">
        <strong>{{ partnerName(entry.partner) }} · {{ money(entry.amount) }}</strong>
        <span class="text-muted"> · {{ entry.periodFrom.slice(0, 10) }}–{{ entry.periodTo.slice(0, 10) }} · {{ date(entry.paidAt) }}</span>
        <p v-if="entry.comment">{{ entry.comment }}</p>
      </div>
    </UCard>
  </section>
</template>
<script setup lang="ts">
import type { FinanceReport, Payout } from '~/types/admin-ops';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const { data: report } = await useApi<FinanceReport>('/admin/finance', { query: { period: 'month' } });
const { data: payouts, error, refresh } = await useApi<Payout[]>('/admin/payouts');
const partner = ref(1);
const partnerOptions = computed(() => (report.value?.partnerNames ?? ['Партнёр 1', 'Партнёр 2']).map((label, index) => ({ label, value: index + 1 })));
const partnerName = (id: number) => report.value?.partnerNames[id - 1] ?? `Партнёр ${id}`;
const amount = ref('');
const periodFrom = ref(report.value?.period.from ?? '');
const periodTo = ref(report.value?.period.to ?? '');
const paidAt = ref('');
onMounted(() => { paidAt.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
const comment = ref('');
const busy = ref(false);
const key = ref('');
const api = useApiClient(); const toast = useToast();
const date = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const paid = (id: number) => (payouts.value ?? []).filter(entry => entry.partner === id &&
  entry.periodFrom.slice(0, 10) >= (report.value?.period.from ?? '') &&
  entry.periodTo.slice(0, 10) <= (report.value?.period.to ?? '')).reduce((acc, entry) => acc + entry.amount, 0);
async function save() {
  if (busy.value) return;
  const negative = amount.value.trim().startsWith('-');
  const parsed = rublesToKopecks(negative ? amount.value.trim().slice(1) : amount.value.trim());
  if (parsed === null || !periodFrom.value || !periodTo.value || periodFrom.value > periodTo.value) {
    toast.add({ title: 'Проверьте сумму и период', color: 'error' }); return;
  }
  busy.value = true;
  if (!key.value) key.value = crypto.randomUUID();
  try {
    await api('/admin/payouts', { method: 'POST', body: {
      partner: partner.value, periodFrom: periodFrom.value, periodTo: periodTo.value,
      amount: negative ? -parsed : parsed, paidAt: new Date(paidAt.value).toISOString(),
      comment: comment.value.trim() || null, idempotencyKey: key.value,
    } });
    key.value = ''; amount.value = ''; comment.value = '';
    await refresh(); toast.add({ title: 'Выплата записана', color: 'success' });
  } catch (cause) { toast.add({ title: apiError(cause), color: 'error' }); }
  finally { busy.value = false; }
}
</script>
