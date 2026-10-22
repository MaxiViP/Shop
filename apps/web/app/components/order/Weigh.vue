<template>
  <section class="weigh" aria-labelledby="weigh-title">
    <header class="weigh__header">
      <NuxtLink :to="fullOrder" class="weigh__back"><UIcon name="i-lucide-chevron-left" />К заказу</NuxtLink>
      <strong>Заказ №{{ order.id }}</strong>
      <span>{{ done }} из {{ order.items.length }}</span>
    </header>
    <progress class="weigh__progress" :value="done" :max="order.items.length || 1" :aria-label="`Собрано ${done} из ${order.items.length}`" />
    <template v-if="item">
      <h1 id="weigh-title">{{ item.productName }}</h1>
      <p class="weigh__requested">Заказано {{ qtyText(item.unit, item.qty, item) }} · {{ money(item.actualPrice ?? item.price) }} / {{ qtyText(priceUnit(item), item.priceQty) }}</p>
      <template v-if="editable">
        <form class="weigh__form" @submit.prevent="save">
          <label for="weigh-quantity">{{ item.unit === 'GRAM' ? 'Фактический вес, г' : 'Фактическое количество' }}</label>
          <input id="weigh-quantity" v-model="quantity" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" autocomplete="off" placeholder="0" :disabled="busy || uncertain" :aria-describedby="whole ? 'weigh-pieces-help' : 'weigh-help'">
          <p v-if="!whole" id="weigh-help" class="weigh__hint">{{ item.unit === 'GRAM' ? 'Введите показание весов в целых граммах.' : 'Подтвердите фактически собранное количество.' }}</p>
          <template v-else>
            <p id="weigh-pieces-help" class="weigh__hint">Взвесьте каждый экземпляр отдельно. Общий вес по пакетам не распределяем.</p>
            <p v-if="item.weightMinGrams || item.weightMaxGrams" class="weigh__hint">Пожелания на экземпляр: {{ item.weightMinGrams ? `от ${qtyText('GRAM', item.weightMinGrams)}` : '' }} {{ item.weightMaxGrams ? `до ${qtyText('GRAM', item.weightMaxGrams)}` : '' }}.</p>
            <div v-for="(_, index) in weights" :key="index" class="weigh__piece">
              <label :for="`weigh-piece-${index}`">Экземпляр {{ index + 1 }} из {{ weights.length }}, г</label>
              <input :id="`weigh-piece-${index}`" v-model="weights[index]" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7" autocomplete="off" placeholder="Вес в граммах" :disabled="busy || uncertain">
            </div>
          </template>
          <div class="weigh__quote" aria-live="polite" role="status">
            <template v-if="quote"><span>{{ signedQuantity(quote.quantityDelta) }} к заказанному{{ quote.actualWeightGrams ? ` · общий вес ${qtyText('GRAM', quote.actualWeightGrams)}` : '' }}</span><strong>{{ money(quote.actualTotal) }}</strong><small v-if="quote.amountDelta !== null">{{ signedMoney(quote.amountDelta) }} к предварительной сумме</small><small v-if="quote.requiresApproval">После сохранения потребуется согласование покупателя.</small></template>
            <span v-else>{{ quoteLoading ? 'Проверяем стоимость…' : quoteError || 'Введите количество и показания весов.' }}</span>
            <UButton v-if="quoteError" type="button" variant="ghost" color="neutral" :disabled="busy || uncertain" @click="requestQuote">Повторить расчёт</UButton>
          </div>
          <UButton type="submit" size="xl" block :loading="busy" :disabled="!quote || quoteLoading || busy || uncertain">Сохранить → следующая</UButton>
        </form>
        <div class="weigh__actions"><UButton color="error" variant="soft" :disabled="busy || uncertain" @click="markMissing">Товара нет</UButton><UButton color="neutral" variant="soft" :disabled="busy || uncertain || !nextId" @click="skip">Пропустить</UButton></div>
      </template>
      <div v-else class="weigh__state">
        <p>{{ item.status === 'MISSING' ? 'Отмечено отсутствие товара.' : item.status === 'PICKED' ? `Сохранено: ${qtyText(item.unit, item.actualQty ?? item.qty, item)}${item.actualWeightGrams ? ` · ${qtyText('GRAM', item.actualWeightGrams)}` : ''}. ${item.actualTotal === null ? '' : money(item.actualTotal)}` : 'Эта позиция сейчас недоступна для сборки.' }}</p>
        <template v-if="canReset">
          <UButton v-if="!resetConfirm" color="neutral" variant="outline" :disabled="busy || uncertain" @click="resetConfirm = true">Исправить эту позицию</UButton>
          <template v-else><UAlert color="warning" title="Вернуть позицию в сборку?" description="Сохранённый вес и согласование будут сброшены. Нужно заново взвесить товар." /><UButton :loading="busy" :disabled="busy || uncertain" @click="resetItem">Вернуть в сборку</UButton><UButton color="neutral" variant="ghost" :disabled="busy || uncertain" @click="resetConfirm = false">Оставить как есть</UButton></template>
        </template>
        <UButton v-if="nextId" color="neutral" :disabled="busy || uncertain" @click="skip">Следующая несобранная →</UButton>
      </div>
    </template>
    <template v-else><h1 id="weigh-title">Позиция недоступна</h1><p>Обновите заказ и выберите актуальный товар.</p></template>
    <UAlert v-if="error" color="error" title="Проверьте заказ" :description="error" />
    <UButton v-if="!nextId && !editable" :to="fullOrder" :disabled="busy || uncertain" size="lg">Проверить сборку в заказе</UButton>
    <div v-if="receipt" class="weigh__receipt" role="status" aria-live="polite"><p>{{ receipt.text }}</p><UButton color="neutral" variant="ghost" :disabled="busy || uncertain" @click="focus(receipt.itemId)">Исправить {{ receipt.name }}</UButton></div>
    <NuxtLink :to="{ ...fullOrder, hash: '#order-issues' }" class="weigh__attention">Нужно вам: {{ sellerWaiting }} · Ждём покупателя: {{ customerWaiting }}</NuxtLink>
    <UButton color="neutral" variant="ghost" :disabled="busy" @click="reloadOrder">Обновить заказ</UButton>
  </section>
</template>

<script setup lang="ts">
import type { StaffOrderDetail } from '~/types/order';
import { useAuthStore } from '~/stores/auth';
import { isStaff } from '~/utils/permissions';
import { priceUnit, variableWeight } from '~/utils/sale';
import { qtyText } from '~/utils/qty';
import { money } from '~/utils/money';
import { apiError } from '~/utils/api-error';
import { nextWeighItem, weighInput, type WeighQuote } from '~/utils/weigh';

const props = defineProps<{ order: StaffOrderDetail; itemId: number; reload: () => Promise<void> }>();
const api = useApiClient(), route = useRoute(), auth = useAuthStore();
const quantity = ref(''), weights = ref<string[]>([]), quote = ref<WeighQuote | null>(null);
const quoteLoading = ref(false), quoteError = ref(''), busy = ref(false), uncertain = ref(false), error = ref(''), resetConfirm = ref(false);
const receipt = ref<{ itemId: number; name: string; text: string } | null>(null);
const item = computed(() => props.order.items.find(row => row.id === props.itemId));
const whole = computed(() => Boolean(item.value && variableWeight(item.value)));
const assembling = computed(() => isStaff(auth.user) && props.order.status === 'ASSEMBLING' && !props.order.assemblyFinalizedAt && !['REPORTED', 'PAID'].includes(props.order.payment?.status ?? ''));
const issue = computed(() => props.order.issues.find(row => row.orderItemId === props.itemId));
const removed = computed(() => Boolean(issue.value?.replacementItemId || (issue.value?.status === 'RESOLVED' && issue.value.resolution === 'REMOVE_ITEM')));
const editable = computed(() => assembling.value && item.value?.status === 'PENDING' && !removed.value);
const canReset = computed(() => assembling.value && item.value && ['PICKED', 'MISSING'].includes(item.value.status) && !removed.value);
const done = computed(() => props.order.items.filter(row => row.status !== 'PENDING').length);
const sellerWaiting = computed(() => props.order.issues.filter(row => row.status === 'WAITING_SELLER' ||
  (row.status === 'RESOLVED' && row.resolution === 'ACCEPT_REPLACEMENT' &&
    props.order.items.some(item => item.id === row.replacementItemId && item.status === 'PENDING'))).length);
const customerWaiting = computed(() => props.order.issues.filter(row => row.status === 'WAITING_CUSTOMER').length);
const nextId = computed(() => nextWeighItem(props.order.items, props.order.issues, props.itemId));
const fullOrder = computed(() => { const { weigh: _weigh, ...query } = route.query; return { path: route.path, query, hash: '#assembly' }; });
const body = computed(() => item.value && editable.value && !uncertain.value ? weighInput(item.value, quantity.value, weights.value) : null);
const signedQuantity = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}${qtyText(item.value?.unit ?? 'GRAM', Math.abs(value), item.value)}`;
const signedMoney = (value: number) => `${value < 0 ? '−' : value > 0 ? '+' : ''}${money(Math.abs(value))}`;
let sequence = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
const validResponse = (version: number, owner: number | undefined) => !disposed && sequence === version && auth.user?.id === owner;
function invalidate() { sequence++; controller?.abort(); clearTimeout(timer); quote.value = null; quoteLoading.value = false; quoteError.value = ''; }
function resizeWeights(clear = false) {
  const count = Number(quantity.value);
  weights.value = whole.value && Number.isSafeInteger(count) && count > 0 && count <= 100
    ? Array.from({ length: count }, (_, index) => clear ? '' : weights.value[index] ?? '') : [];
}
watch(() => [props.itemId, props.order.id, auth.user?.id] as const, () => {
  invalidate(); resetConfirm.value = false; error.value = '';
  quantity.value = item.value && item.value.unit !== 'GRAM' ? String(item.value.qty) : '';
  resizeWeights(true);
}, { immediate: true, flush: 'sync' });
watch(() => [props.order.id, auth.user?.id] as const, () => { receipt.value = null; uncertain.value = false; }, { flush: 'sync' });
watch(quantity, () => resizeWeights(), { flush: 'sync' });
watch(() => [body.value, item.value?.price, item.value?.actualPrice, editable.value], () => {
  invalidate();
  if (!body.value || busy.value) return;
  quoteLoading.value = true;
  timer = setTimeout(() => void requestQuote(), 250);
}, { deep: true, immediate: true });
onBeforeUnmount(() => { disposed = true; invalidate(); });

async function requestQuote() {
  invalidate();
  if (!body.value || busy.value) return;
  const version = sequence, owner = auth.user?.id;
  controller = new AbortController(); quoteLoading.value = true;
  try {
    const result = await api<WeighQuote>(`/staff/orders/${props.order.id}/items/${props.itemId}/quote`, { method: 'POST', body: body.value, signal: controller.signal });
    if (validResponse(version, owner)) quote.value = result;
  } catch (cause) {
    if (validResponse(version, owner)) quoteError.value = apiError(cause);
  } finally { if (validResponse(version, owner)) quoteLoading.value = false; }
}
async function moveFocus(itemId: number) { await navigateTo({ path: route.path, query: { ...route.query, weigh: String(itemId) }, hash: '#assembly' }, { replace: true }); }
async function focus(itemId: number) { if (!busy.value && !uncertain.value) await moveFocus(itemId); }
async function skip() { if (nextId.value) await focus(nextId.value); }
async function mutate(data: { status: 'PICKED'; actualQty: number; pieceWeights?: number[] } | { status: 'MISSING' } | { status: 'PENDING' }) {
  if (busy.value || uncertain.value || !item.value || !assembling.value) return;
  const target = item.value, orderId = props.order.id, owner = auth.user?.id;
  busy.value = true; error.value = ''; invalidate();
  try {
    const saved = await api<StaffOrderDetail['items'][number]>(`/staff/orders/${orderId}/items/${target.id}`, { method: 'PATCH', body: data });
    if (disposed || auth.user?.id !== owner || props.order.id !== orderId || props.itemId !== target.id) return;
    await props.reload();
    if (disposed || auth.user?.id !== owner || props.order.id !== orderId || props.itemId !== target.id) return;
    if (data.status !== 'PENDING') {
      const notice = { itemId: target.id, name: target.productName, text: data.status === 'MISSING' ? `Нет в наличии: ${target.productName}.` : `Сохранено: ${target.productName} · ${qtyText(target.unit, saved.actualQty ?? data.actualQty, target)}${saved.actualWeightGrams ? ` · ${qtyText('GRAM', saved.actualWeightGrams)}` : ''} · ${saved.actualTotal === null ? 'Стоимость уточняется' : money(saved.actualTotal)}` };
      const next = nextWeighItem(props.order.items, props.order.issues, target.id);
      if (next) await moveFocus(next);
      if (disposed || auth.user?.id !== owner || props.order.id !== orderId) return;
      receipt.value = notice;
    } else { resetConfirm.value = false; quantity.value = target.unit === 'GRAM' ? '' : String(target.qty); resizeWeights(true); }
  } catch (cause) {
    if (!disposed && auth.user?.id === owner && props.order.id === orderId && props.itemId === target.id) {
      uncertain.value = true;
      error.value = `${apiError(cause)} Обновите заказ перед повторным действием.`;
      try { await props.reload(); uncertain.value = false; } catch { /* Keep writes blocked until the saved state is known. */ }
    }
  } finally {
    busy.value = false;
    if (!disposed && auth.user?.id === owner && props.order.id === orderId && editable.value && body.value) void requestQuote();
  }
}
async function save() { if (quote.value && !quoteLoading.value && body.value) await mutate(body.value); }
async function markMissing() { if (editable.value) await mutate({ status: 'MISSING' }); }
async function resetItem() { if (canReset.value && resetConfirm.value) await mutate({ status: 'PENDING' }); }
async function reloadOrder() {
  if (busy.value) return;
  busy.value = true; invalidate(); error.value = '';
  try { await props.reload(); uncertain.value = false; }
  catch (cause) { uncertain.value = true; error.value = apiError(cause); }
  finally { busy.value = false; }
  if (!uncertain.value) await requestQuote();
}
</script>

<style scoped>
.weigh { max-width: 32rem; margin: 0 auto; padding: 1rem 1rem calc(2rem + var(--safe-bottom, 0px)); display: grid; gap: 1rem; }
.weigh__header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; font-size: 0.875rem; }
.weigh__back { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--ui-primary); min-height: 2.75rem; }
.weigh__header span, .weigh__requested, .weigh__hint { color: var(--ui-text-muted); }
.weigh__progress { width: 100%; height: 0.375rem; accent-color: var(--ui-primary); }
.weigh h1 { font-size: 1.625rem; font-weight: 700; overflow-wrap: anywhere; }
.weigh__form, .weigh__piece, .weigh__state { display: grid; gap: 0.75rem; }
.weigh__form label { font-weight: 600; }
.weigh__form input { width: 100%; min-width: 0; border: 2px solid var(--ui-border); border-radius: 0.75rem; background: var(--ui-bg); color: var(--ui-text); padding: 0.75rem 1rem; font-size: 2rem; font-variant-numeric: tabular-nums; min-height: 4rem; }
.weigh__form input:focus { border-color: var(--ui-primary); }
.weigh__piece input { font-size: 1.5rem; }
.weigh__hint { font-size: 0.875rem; }
.weigh__quote { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 0.5rem 0.75rem; min-height: 5rem; padding: 0.75rem 0; font-variant-numeric: tabular-nums; }
.weigh__quote strong { font-size: 1.375rem; }
.weigh__quote small, .weigh__quote :deep(button) { grid-column: 1 / -1; }
.weigh__actions { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.weigh__actions :deep(button), .weigh__form :deep(button) { min-height: 3rem; justify-content: center; }
.weigh__receipt { padding-top: 1rem; border-top: 1px solid var(--ui-border); }
.weigh__attention { padding-top: 1rem; border-top: 1px solid var(--ui-border); color: var(--ui-primary); font-size: 0.875rem; min-height: 2.75rem; }
@media (max-width: 23rem) { .weigh__header { flex-wrap: wrap; } .weigh__quote { grid-template-columns: 1fr; } }
</style>
