<template>
  <section class="promo-admin">
    <h2 class="text-2xl font-semibold">Промокоды</h2>
    <p class="text-muted">Персональные компенсации покупателям. К одному заказу применяется один промокод.</p>
    <UCard>
      <template #header><h3 class="font-semibold">Выдать промокод</h3></template>
      <form class="promo-admin__search" @submit.prevent="findUsers">
        <UFormField label="Найти покупателя по имени или телефону"><UInput v-model="search" class="w-full" maxlength="100" /></UFormField>
        <UButton type="submit" variant="outline" :loading="usersPending" icon="i-lucide-search">Найти</UButton>
      </form>
      <UAlert v-if="usersError" color="error" :title="apiError(usersError)" />
      <div class="promo-admin__users">
        <UButton v-for="user in users?.items" :key="user.id" :variant="selected?.id === user.id ? 'solid' : 'outline'" :disabled="busy" @click="selected = user">
          {{ user.name || 'Покупатель' }} · {{ user.phone || 'Телефон не указан' }} · №{{ user.id }}
        </UButton>
        <p v-if="searched && !usersPending && !users?.items.length" class="text-muted">Покупатель не найден.</p>
      </div>
      <form class="promo-admin__form" @submit.prevent="issue">
        <p class="promo-admin__wide">{{ selected ? 'Выбран: ' + (selected.name || 'Покупатель') + ' · №' + selected.id : 'Сначала выберите существующего покупателя.' }}</p>
        <UFormField label="Название для покупателя" required><UInput v-model="title" required maxlength="160" :disabled="busy" class="w-full" /></UFormField>
        <UFormField label="Тип скидки"><USelect v-model="type" :items="[{ label: 'Сумма в рублях', value: 'FIXED' }, { label: 'Процент', value: 'PERCENT' }]" :disabled="busy" class="w-full" /></UFormField>
        <UFormField :label="type === 'FIXED' ? 'Скидка, ₽' : 'Скидка, %'" required><UInput v-model="value" required inputmode="decimal" :disabled="busy" class="w-full" /></UFormField>
        <UFormField v-if="type === 'PERCENT'" label="Максимальная скидка, ₽" required><UInput v-model="maximum" required inputmode="decimal" :disabled="busy" class="w-full" /></UFormField>
        <UFormField label="Минимальная сумма товаров, ₽"><UInput v-model="minimum" inputmode="decimal" :disabled="busy" placeholder="Без минимума" class="w-full" /></UFormField>
        <UFormField label="Действует до (локальное время)" required><UInput v-model="expiresAt" type="datetime-local" required :disabled="busy" class="w-full" /></UFormField>
        <UFormField label="Исходный заказ, №" description="Необязательно. Заказ должен принадлежать выбранному покупателю."><UInput v-model="sourceOrderId" inputmode="numeric" :disabled="busy" class="w-full" /></UFormField>
        <UFormField label="Внутренняя причина" description="Доступна только администраторам." required class="promo-admin__wide"><UTextarea v-model="reason" required maxlength="1000" :disabled="busy" class="w-full" /></UFormField>
        <div class="promo-admin__actions promo-admin__wide"><UButton type="submit" :disabled="!selected" :loading="busy" icon="i-lucide-ticket">Выдать промокод</UButton></div>
      </form>
    </UCard>
    <h3 class="text-xl font-semibold">Выданные промокоды</h3>
    <div class="promo-admin__filters">
      <UFormField label="Статус"><USelect v-model="statusFilter" :items="statusItems" class="w-full" /></UFormField>
      <UButton variant="outline" :disabled="!selected" @click="filterUser(selected?.id)">Коды выбранного покупателя</UButton>
      <UButton variant="ghost" @click="filterUser()">Все покупатели</UButton>
    </div>
    <p v-if="query.userId" class="text-muted">Покупатель №{{ query.userId }}</p>
    <UAlert v-if="error" color="error" :title="apiError(error)" :actions="[{ label: 'Повторить', onClick: () => refresh() }]" />
    <p v-if="pending">Загрузка…</p>
    <p v-else-if="!data?.items.length">Промокодов пока нет.</p>
    <UCard v-for="promo in data?.items" :key="promo.id">
      <div class="promo-admin__row">
        <div class="promo-admin__info"><h4 class="font-semibold">{{ promo.title }}</h4><code class="promo-admin__code">{{ promo.code }}</code><p>{{ promoDescription(promo) }}</p></div>
        <UBadge :color="promo.status === 'AVAILABLE' ? 'success' : 'neutral'">{{ promoStatusLabels[promo.status] }}</UBadge>
        <UButton v-if="promo.status === 'AVAILABLE' || promo.status === 'EXPIRED'" variant="outline" color="error" :disabled="busy" @click="revoking = promo">Отозвать</UButton>
      </div>
      <p>{{ promo.user.name || 'Покупатель' }} · {{ promo.user.phone || 'Телефон не указан' }} · №{{ promo.user.id }}</p>
      <p>До {{ promoDate(promo.expiresAt) }} (МСК) · Минимум {{ money(promo.minSubtotal) }}</p>
      <p class="text-muted">Внутренняя причина: {{ promo.reason }}</p>
      <UButton v-if="promo.sourceOrderId" :to="'/admin/orders/' + promo.sourceOrderId" variant="link">Исходный заказ №{{ promo.sourceOrderId }}</UButton>
      <p v-if="promo.usedAt">Использован {{ promoDate(promo.usedAt) }} (МСК)</p>
      <UButton v-if="promo.usedOrder" :to="'/admin/orders/' + promo.usedOrder.id" variant="link">Заказ №{{ promo.usedOrder.id }}</UButton>
      <div v-if="promo.orders.length" class="promo-admin__history"><span class="text-muted">История применения:</span><UButton v-for="order in promo.orders" :key="order.id" :to="'/admin/orders/' + order.id" variant="link" size="sm">№{{ order.id }} · {{ order.status }} · {{ money(order.finalPromoDiscount ?? order.promoDiscount) }}</UButton></div>
    </UCard>
    <UPagination v-if="data && data.total > query.limit" v-model:page="query.page" :total="data.total" :items-per-page="query.limit" :sibling-count="0" />
    <UModal v-model:open="revokeOpen" title="Отозвать промокод?" :description="revoking?.code">
      <template #body><p>Покупатель больше не сможет применить этот код.</p><div class="promo-admin__actions"><UButton color="error" :loading="busy" @click="revoke">Отозвать</UButton><UButton variant="outline" :disabled="busy" @click="revoking = null">Отмена</UButton></div></template>
    </UModal>
  </section>
</template>

<script setup lang="ts">
import type { AdminPage, AdminUser } from '~/types/admin';
import type { AdminPromo } from '~/types/promo';
import { promoDate, promoDescription, promoStatusLabels } from '~/utils/promo';
import { money, rublesToKopecks } from '~/utils/money';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const api = useApiClient(), toast = useToast();
const selected = ref<AdminUser | null>(null), search = ref(''), searched = ref(false);
const userQuery = reactive({ role: 'USER', search: '', page: 1, limit: 10 });
const { data: users, pending: usersPending, error: usersError, refresh: refreshUsers } = await useApi<AdminPage<AdminUser>>('/admin/users', { query: userQuery, immediate: false });
const query = reactive({ page: 1, limit: 20, userId: undefined as number | undefined, status: undefined as string | undefined });
const { data, pending, error, refresh } = await useApi<AdminPage<AdminPromo>>('/admin/promo-codes', { query });
const statusFilter = ref('ALL');
const statusItems = [{ label: 'Все статусы', value: 'ALL' }, ...Object.entries(promoStatusLabels).map(([value, label]) => ({ value, label }))];
watch(statusFilter, value => { query.status = value === 'ALL' ? undefined : value; query.page = 1; });
const title = ref('Персональная скидка'), type = ref<'FIXED' | 'PERCENT'>('FIXED');
const value = ref(''), maximum = ref(''), minimum = ref(''), expiresAt = ref(''), reason = ref(''), sourceOrderId = ref('');
const busy = ref(false), revoking = ref<AdminPromo | null>(null);
const revokeOpen = computed({ get: () => revoking.value !== null, set: open => { if (!open) revoking.value = null; } });
async function findUsers() { searched.value = true; userQuery.search = search.value.trim(); await refreshUsers(); }
function filterUser(id?: number) { query.userId = id; query.page = 1; }
async function issue() {
  if (busy.value || !selected.value) return;
  const amount = rublesToKopecks(value.value), minSubtotal = minimum.value.trim() ? rublesToKopecks(minimum.value, true) : 0;
  const maxDiscount = type.value === 'PERCENT' ? rublesToKopecks(maximum.value) : null;
  if (amount === null || minSubtotal === null || (type.value === 'PERCENT' && (!maxDiscount || amount > 10000))) {
    toast.add({ title: 'Проверьте сумму, процент и максимальную скидку', color: 'error' }); return;
  }
  busy.value = true;
  try {
    await api('/admin/promo-codes', { method: 'POST', body: {
      userId: selected.value.id, title: title.value.trim(), type: type.value,
      amount: type.value === 'FIXED' ? amount : null, percentBps: type.value === 'PERCENT' ? amount : null,
      maxDiscount, minSubtotal, expiresAt: new Date(expiresAt.value).toISOString(), reason: reason.value.trim(),
      sourceOrderId: sourceOrderId.value.trim() ? Number(sourceOrderId.value) : null,
    } });
    value.value = ''; maximum.value = ''; reason.value = ''; sourceOrderId.value = '';
    await refresh(); toast.add({ title: 'Промокод выдан', color: 'success' });
  } catch (error) { toast.add({ title: apiError(error), color: 'error' }); } finally { busy.value = false; }
}
async function revoke() {
  if (busy.value || !revoking.value) return;
  busy.value = true;
  try { await api('/admin/promo-codes/' + revoking.value.id + '/revoke', { method: 'POST' }); revoking.value = null; await refresh(); }
  catch (error) { toast.add({ title: apiError(error), color: 'error' }); } finally { busy.value = false; }
}
</script>

<style scoped>
.promo-admin { display: grid; gap: 1rem; min-width: 0; }
.promo-admin__search, .promo-admin__form, .promo-admin__filters { display: grid; gap: 0.75rem; margin-block: 1rem; align-items: end; min-width: 0; }
.promo-admin__row, .promo-admin__actions, .promo-admin__users, .promo-admin__history { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
.promo-admin__actions { margin-top: 1rem; }
.promo-admin__users :deep(button) { white-space: normal; overflow-wrap: anywhere; max-width: 100%; }
.promo-admin__info { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.promo-admin__code { display: block; overflow-wrap: anywhere; margin-block: 0.25rem; }
@media (min-width: 48rem) { .promo-admin__form { grid-template-columns: repeat(2, minmax(0, 1fr)); } .promo-admin__wide { grid-column: 1 / -1; } .promo-admin__search, .promo-admin__filters { grid-template-columns: 1fr auto auto; } }
</style>
