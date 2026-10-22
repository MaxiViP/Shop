<template>
  <div class="quick-shop">
    <header class="quick-shop__header">
      <NuxtLink to="/" class="quick-shop__brand">KorzinaMarket<span>Быстро и по делу</span></NuxtLink>
      <UButton to="/orders" color="neutral" variant="ghost" icon="i-lucide-package">Заказы</UButton>
    </header>
    <main class="quick-shop__main">
      <div class="quick-shop__title-row"><div><h1>Быстрые покупки</h1><p>Привычные продукты, вес и сумма — рядом.</p></div></div>
      <section v-if="!customer" class="quick-shop__signin" aria-labelledby="quick-signin-title">
        <h2 id="quick-signin-title">{{ auth.loggedIn ? 'Покупки в аккаунте покупателя' : 'Ваши продукты всегда под рукой' }}</h2>
        <p>{{ auth.loggedIn ? 'Этот раздел доступен покупателю. Каталог можно открыть по ссылке ниже.' : 'Войдите, чтобы видеть привычные товары, повторять заказы и пользоваться общей корзиной с Telegram.' }}</p>
        <div class="quick-shop__actions"><UButton v-if="!auth.loggedIn" size="lg" @click="loginOpen = true">Войти</UButton><UButton to="/catalog" color="neutral" variant="outline">Открыть каталог</UButton></div>
      </section>
      <template v-else>
        <section v-if="repeatOrderId" class="quick-shop__repeat" aria-labelledby="quick-repeat-title">
          <div><h2 id="quick-repeat-title">{{ selectedOrderId ? `Повторить заказ №${selectedOrderId}?` : 'Повторить последний заказ' }}</h2><p v-if="lastOrder && repeatOrderId === lastOrder.id">№{{ lastOrder.id }} · {{ orderDate(lastOrder.createdAt) }} · {{ lastOrder.itemCount }} поз.</p><p v-else>Проверьте корзину и нажмите «Повторить», чтобы добавить товары.</p></div>
          <UButton icon="i-lucide-rotate-ccw" :disabled="disabled" :loading="repeating" @click="repeatLast">Повторить</UButton>
          <p class="quick-shop__repeat-hint">Добавим только отсутствующие в корзине товары по текущим ценам. Перед оформлением проверьте состав.</p>
        </section>
        <section v-if="repeatResult" class="quick-shop__review" aria-labelledby="quick-review-title" role="status">
          <h2 id="quick-review-title">Состав заказа восстановлен</h2><p>Добавлено позиций: {{ repeatResult.added }}. Товары, которые уже были в корзине, сохранены.</p>
          <ul v-if="repeatResult.skipped.length"><li v-for="(item, index) in repeatResult.skipped" :key="`${item.productId ?? item.name}:${index}`"><strong>{{ item.name }}</strong>: {{ item.reason }}</li></ul>
          <UButton to="/cart" color="neutral" variant="outline" :disabled="disabled">Проверить состав и количество</UButton>
        </section>
        <form class="quick-shop__search" role="search" @submit.prevent="searchNow">
          <label for="quick-search" class="sr-only">Найти продукт</label><UIcon name="i-lucide-search" aria-hidden="true" />
          <input id="quick-search" v-model="query" type="search" maxlength="100" placeholder="Найти продукт, например помидоры" autocomplete="off" :disabled="pending || cart.serverBusy" @input="restoreScroll = null">
          <button v-if="query" type="button" :disabled="pending || cart.serverBusy" aria-label="Очистить поиск" @click="query = ''; restoreScroll = null"><UIcon name="i-lucide-x" aria-hidden="true" /></button>
        </form>
        <nav class="quick-shop__tabs" aria-label="Список продуктов">
          <button v-for="tab in tabs" :key="tab.value" type="button" :aria-pressed="filter === tab.value" @click="filter = tab.value; restoreScroll = null">{{ tab.label }}<span v-if="tab.value === 'cart' && cart.restored"> · {{ cart.count }}</span></button>
        </nav>
        <div class="quick-shop__list-heading"><h2>{{ query.trim() ? 'Результаты поиска' : filter === 'favorites' ? 'Избранное' : filter === 'cart' ? 'В корзине' : 'Мои продукты' }}</h2><UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" :disabled="loading || pending || cart.serverBusy || searchLoading || loadingFavorites || favoriteBusy" aria-label="Обновить список и корзину" @click="refresh">Обновить</UButton></div>
        <p v-if="loading || searchLoading || loadingFavorites" class="quick-shop__state" role="status">{{ searchLoading ? 'Ищем продукты и проверяем цены…' : loadingFavorites ? 'Загружаем избранное и проверяем цены…' : 'Загружаем продукты…' }}</p>
        <UAlert v-if="favoriteLoadError && filter === 'favorites'" color="error" title="Не удалось загрузить всё избранное" :description="favoriteLoadError" class="quick-shop__alert" />
        <UAlert v-if="loadError" color="error" title="Не удалось обновить продукты" :description="loadError" class="quick-shop__alert" />
        <UAlert v-if="error" color="error" title="Проверьте корзину" :description="error" class="quick-shop__alert" />
        <p v-if="notice" class="quick-shop__notice" role="status" aria-live="polite">{{ notice }}</p>
        <div v-if="receipt && !receiptInList" class="quick-shop__notice" role="status" aria-live="polite"><p>{{ receipt.text }}</p><UButton v-if="canUndo" color="neutral" variant="outline" :disabled="disabled" @click="undoQuantity">Вернуть</UButton></div>
        <div v-if="!cart.restored || cart.mode !== 'server' || cart.serverOwner !== owner" class="quick-shop__restore" role="status"><p>Загружаем вашу общую корзину…</p><p v-if="cart.storageWarning">{{ cart.storageWarning }}</p><UButton v-if="!loading" color="neutral" variant="outline" @click="reloadNuxtApp()">Загрузить заново</UButton></div>
        <div v-if="rows.length" class="quick-shop__list" :aria-busy="disabled">
          <QuickShopItem v-for="row in rows" :key="row.product.id" :product="row.product" :qty="cart.qty(row.product.id)" :line="row.line" :suggested-qty="row.suggestedQty" :suggested-total="row.suggestedTotal" :disabled="disabled" :message="receipt?.productId === row.product.id ? receipt.text : undefined" :undo="receipt?.productId === row.product.id && canUndo" @change="changeQuantity(row.product, $event)" @undo="undoQuantity" />
        </div>
        <div v-else-if="!loading && !searchLoading && !loadingFavorites && !loadError" class="quick-shop__empty"><UIcon name="i-lucide-shopping-basket" aria-hidden="true" /><p>{{ query.trim().length === 1 ? 'Введите хотя бы две буквы.' : query.trim() ? 'Продукты не найдены. Попробуйте другое название.' : filter === 'cart' ? 'Корзина пока пуста. Выберите продукты во вкладке «Мои продукты».' : filter === 'favorites' ? 'Здесь появятся товары, отмеченные сердечком.' : 'Пока нет привычных продуктов. Найдите их через поиск или каталог.' }}</p><UButton v-if="!query && filter !== 'cart'" to="/catalog" color="neutral" variant="outline">Открыть каталог</UButton></div>
        <p class="quick-shop__footnote">Точная стоимость весовых товаров — после сборки. Доставка и способ получения выбираются при оформлении.</p>
      </template>
    </main>
    <footer v-if="customer" class="quick-shop__cart" aria-label="Ваша корзина">
      <div class="quick-shop__cart-inner"><div class="quick-shop__cart-copy"><span>Корзина · {{ cart.restored ? cart.count : '…' }} поз.</span><strong>{{ cartSummary }}</strong><small v-if="cart.quoteReady && cart.quote?.valid && goodsTotal === null && cart.quote?.knownSubtotal != null">Известная часть: {{ money(cart.quote.knownSubtotal) }}</small><small v-if="cart.quoteReady && cart.quote?.promo?.eligible && cart.quote.promo.discount">Скидка: {{ money(cart.quote.promo.discount) }}</small></div><UButton :to="checkoutReady ? '/cart' : undefined" :disabled="!checkoutReady" size="lg" icon="i-lucide-arrow-right" trailing>Проверить заказ</UButton></div>
    </footer>
    <LazyAuthModal v-if="loginOpen" v-model:open="loginOpen" />
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem, ProductListResponse } from '~/types/product';
import type { QuickShopResponse, QuickShopSuggestion, RepeatCartResponse } from '~/types/quick-shop';
import type { CartQuote } from '~/utils/cart';
import { validCartQty } from '~/utils/cart';
import { quickShopChange, quickShopContext, quickShopOrderId, quickShopRows, quickShopUndo, type QuickShopFilter, type QuickShopUndo } from '~/utils/quick-shop';
import { money } from '~/utils/money';
import { useAuthStore } from '~/stores/auth';
import { useCartStore } from '~/stores/cart';
import { useFavoritesStore } from '~/stores/favorites';

definePageMeta({ layout: false });
useSeoMeta({ title: 'Быстрые покупки — KorzinaMarket', robots: 'noindex, follow' });
const auth = useAuthStore(), cart = useCartStore(), favorites = useFavoritesStore();
const api = useApiClient();
const route = useRoute();
const loginOpen = ref(false), loading = ref(false), pending = ref(false), repeating = ref(false), searchLoading = ref(false), loadingFavorites = ref(false);
const loadError = ref(''), error = ref(''), notice = ref('');
const query = ref(''), filter = ref<QuickShopFilter>('all');
const suggestions = ref<QuickShopSuggestion[]>([]), searchItems = ref<QuickShopSuggestion[]>([]);
const favoriteItems = ref<QuickShopSuggestion[]>([]), favoriteLoadError = ref('');
const favoritesOwner = ref<number | null>(null);
const lastOrder = ref<QuickShopResponse['lastOrder']>(null);
const repeatResult = ref<RepeatCartResponse | null>(null);
const receipt = ref<{ productId: number; text: string; undo: QuickShopUndo | null } | null>(null);
const restoreScroll = ref<number | null>(null);
const selectedOrderId = computed(() => quickShopOrderId(route.query.orderId));
const repeatOrderId = computed(() => selectedOrderId.value ?? lastOrder.value?.id ?? null);
const customer = computed(() => auth.user?.role === 'USER');
const owner = computed(() => customer.value ? auth.user!.id : null);
const ready = computed(() => customer.value && cart.mode === 'server' && cart.serverOwner === owner.value && cart.restored && cart.quoteReady);
const favoriteBusy = computed(() => [...suggestions.value, ...searchItems.value, ...favoriteItems.value].some(item => favorites.pending(item.product.id)) || cart.items.some(item => favorites.pending(item.product.id)));
const disabled = computed(() => !ready.value || loading.value || pending.value || cart.serverBusy || searchLoading.value || loadingFavorites.value || favoriteBusy.value || Boolean(loadError.value));
const checkoutReady = computed(() => !disabled.value && cart.count > 0);
const goodsTotal = computed(() => cart.quote?.goodsTotal === undefined ? cart.total : cart.quote.goodsTotal);
const cartSummary = computed(() => !cart.restored || !cart.quoteReady ? 'Рассчитываем…' : !cart.count ? '0 ₽' : !cart.quote?.valid ? 'Проверьте товары' : goodsTotal.value === null ? 'После взвешивания' : `≈ ${money(goodsTotal.value)}`);
const tabs: { value: QuickShopFilter; label: string }[] = [{ value: 'all', label: 'Мои продукты' }, { value: 'favorites', label: 'Избранное' }, { value: 'cart', label: 'В корзине' }];
const rows = computed(() => {
  const searching = Boolean(query.value.trim());
  const recommended = filter.value === 'favorites' ? [...suggestions.value, ...favoriteItems.value] : suggestions.value;
  const items = searching ? searchItems.value : recommended;
  const ids = new Set(items.map(item => item.product.id));
  return quickShopRows(items, searching ? cart.items.filter(item => ids.has(item.product.id)) : cart.items,
    cart.quoteReady ? cart.quote?.items ?? [] : [], filter.value, favorites.ids);
});
const receiptInList = computed(() => rows.value.some(row => row.product.id === receipt.value?.productId));
const canUndo = computed(() => Boolean(receipt.value?.undo && ready.value && quickShopUndo(receipt.value.undo, cart.quoteLine(receipt.value.productId))));
let disposed = false, generation = 0, searchGeneration = 0, favoriteGeneration = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let contextOwner: number | null = null, savedForLeave = false;
const current = (id: number, userId: number | null) => !disposed && id === generation && userId === owner.value;
const orderDate = (value: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }).format(new Date(value));

onMounted(() => {
  window.addEventListener('pagehide', saveContext);
  watch(() => [auth.user?.id, auth.user?.role] as const, () => {
    saveContext();
    generation++; searchGeneration++; favoriteGeneration++; clearTimeout(searchTimer);
    suggestions.value = []; searchItems.value = []; lastOrder.value = null; repeatResult.value = null;
    favoriteItems.value = []; favoritesOwner.value = null; favoriteLoadError.value = ''; loadingFavorites.value = false;
    loadError.value = ''; error.value = ''; notice.value = ''; query.value = ''; filter.value = 'all'; receipt.value = null;
    pending.value = false; repeating.value = false; searchLoading.value = false; restoreScroll.value = null;
    contextOwner = owner.value;
    if (contextOwner !== null) {
      try {
        const saved = quickShopContext(sessionStorage.getItem(`quick-shop:${contextOwner}`));
        if (saved) { filter.value = saved.filter; query.value = saved.query; restoreScroll.value = saved.scroll; }
      } catch { /* Navigation still works when browser storage is unavailable. */ }
    }
    if (selectedOrderId.value) restoreScroll.value = 0;
    if (owner.value !== null) void refresh(); else loading.value = false;
  }, { immediate: true, flush: 'sync' });
});
onBeforeRouteLeave(() => { saveContext(); savedForLeave = true; });
onBeforeUnmount(() => { if (!savedForLeave) saveContext(); window.removeEventListener('pagehide', saveContext); disposed = true; generation++; searchGeneration++; favoriteGeneration++; clearTimeout(searchTimer); });

function saveContext() {
  if (contextOwner === null || !import.meta.client) return;
  try { sessionStorage.setItem(`quick-shop:${contextOwner}`, JSON.stringify({ version: 1, filter: filter.value, query: query.value, scroll: restoreScroll.value ?? window.scrollY })); }
  catch { /* Do not block shopping because session storage is unavailable. */ }
}
watch([ready, loading, searchLoading, loadingFavorites, () => rows.value.length], async () => {
  if (restoreScroll.value === null || !ready.value || loading.value || searchLoading.value || loadingFavorites.value) return;
  const target = restoreScroll.value, userId = owner.value;
  await nextTick();
  if (disposed || owner.value !== userId || restoreScroll.value !== target || loading.value || searchLoading.value || loadingFavorites.value) return;
  window.scrollTo({ top: target, behavior: 'instant' });
  restoreScroll.value = null;
}, { flush: 'post' });

watch(filter, value => { if (value === 'favorites') void loadFavorites(); });
watch(favoriteBusy, (busy, previous) => {
  if (busy || !previous) return;
  favoritesOwner.value = null;
  // An acknowledged toggle is reflected immediately, including removal of a
  // favorite that was present in the recommendation response.
  suggestions.value = suggestions.value.map(item => item.source === 'favorite' && !favorites.has(item.product.id) ? { ...item, source: 'catalog' } : item);
  favoriteItems.value = favoriteItems.value.filter(item => favorites.has(item.product.id));
  if (filter.value === 'favorites') void loadFavorites(true);
});

async function quoteSuggestions(products: ProductListItem[], source: QuickShopSuggestion['source'], active: () => boolean): Promise<QuickShopSuggestion[]> {
  const candidates = products.map(product => ({ product, qty: validCartQty(product.portionQty, product) ? product.portionQty : product.min }));
  const result: QuickShopSuggestion[] = [];
  for (let offset = 0; offset < candidates.length; offset += 50) {
    if (!active()) return [];
    const batch = candidates.slice(offset, offset + 50);
    const quote = await api<CartQuote>('/orders/quote', { method: 'POST', body: { items: batch.map(({ product, qty }) => ({ productId: product.id, qty, quantityUnit: product.unit })) } });
    if (!active()) return [];
    for (const { product, qty } of batch) {
      const line = quote.items.find(item => item.productId === product.id);
      if (line?.status === 'AVAILABLE') result.push({ product: line.product ?? product, source, suggestedQty: qty, lineTotal: line.lineTotal });
    }
  }
  return result;
}
async function loadFavorites(force = false) {
  const userId = owner.value, id = generation;
  if (userId === null || loadingFavorites.value || (!force && favoritesOwner.value === userId)) return;
  const request = ++favoriteGeneration;
  const active = () => current(id, userId) && request === favoriteGeneration;
  loadingFavorites.value = true; favoriteLoadError.value = '';
  try {
    await favorites.load(force);
    if (!active()) return;
    const result = await quoteSuggestions(favorites.serverItems.slice(0, 100), 'favorite', active);
    if (!active()) return;
    favoriteItems.value = result; favoritesOwner.value = userId;
  } catch (cause) { if (active()) favoriteLoadError.value = apiError(cause); }
  finally { if (active()) loadingFavorites.value = false; }
}

async function refresh() {
  const userId = owner.value;
  if (userId === null || pending.value || cart.serverBusy || loadingFavorites.value || favoriteBusy.value) return;
  const id = ++generation;
  loading.value = true; loadError.value = '';
  try {
    const result = await api<QuickShopResponse>('/cart/quick-shop');
    if (!current(id, userId)) return;
    suggestions.value = result.items; lastOrder.value = result.lastOrder;
    // The plugin owns restoration. Never overwrite a newer cart with the
    // recommendation response's snapshot or race its guest-cart merge.
    if (cart.mode === 'server' && cart.serverOwner === userId) {
      const refreshed = await cart.refreshServer();
      if (!current(id, userId)) return;
      if (!refreshed) loadError.value = 'Не удалось проверить актуальную корзину. Нажмите «Обновить».';
    }
  } catch (cause) {
    if (current(id, userId)) loadError.value = apiError(cause);
  } finally {
    if (current(id, userId)) { loading.value = false; if (filter.value === 'favorites') void loadFavorites(true); }
  }
}

watch([query, owner], () => {
  clearTimeout(searchTimer); searchGeneration++;
  searchItems.value = []; error.value = '';
  if (query.value.trim().length < 2) { searchLoading.value = false; return; }
  searchLoading.value = true;
  searchTimer = setTimeout(() => { void searchNow(); }, 250);
});
async function searchNow() {
  clearTimeout(searchTimer);
  const text = query.value.trim(), userId = owner.value, ownerGeneration = generation;
  if (text.length < 2 || userId === null) return;
  const request = ++searchGeneration;
  searchLoading.value = true; error.value = '';
  const active = () => current(ownerGeneration, userId) && request === searchGeneration && query.value.trim() === text;
  try {
    const products = await api<ProductListResponse>('/products', { query: { q: text, limit: 24, sort: 'name' } });
    if (!active()) return;
    const result = await quoteSuggestions(products.items, 'catalog', active);
    if (!active()) return;
    searchItems.value = result;
  } catch (cause) { if (active()) error.value = apiError(cause); }
  finally { if (active()) searchLoading.value = false; }
}

async function changeQuantity(product: ProductListItem, qty: number) {
  if (disabled.value || (qty !== 0 && !validCartQty(qty, product))) return;
  const id = generation, userId = owner.value, before = cart.quoteLine(product.id);
  pending.value = true; error.value = ''; notice.value = ''; repeatResult.value = null; receipt.value = null;
  try {
    const changed = await cart.changeServer(qty === 0 ? { kind: 'remove', productId: product.id }
      : { kind: 'set', productId: product.id, qty, quantityUnit: product.unit });
    if (!current(id, userId)) return;
    if (!changed) { await unconfirmedChange(id, userId); return; }
    const after = cart.quoteLine(product.id), undo = { productId: product.id, before, after };
    receipt.value = { productId: product.id, text: quickShopChange(product, before, after), undo: quickShopUndo(undo, after) ? undo : null };
  } finally { if (current(id, userId)) pending.value = false; }
}
async function unconfirmedChange(id: number, userId: number | null) {
  // The request may have reached the server. Read only; never replay its POST.
  const refreshed = await cart.refreshServer();
  if (!current(id, userId)) return;
  error.value = 'Не удалось подтвердить изменение. Проверьте текущий состав корзины перед повторным действием.';
  if (!refreshed) loadError.value = 'Не удалось проверить актуальную корзину. Нажмите «Обновить».';
}
async function undoQuantity() {
  const previous = receipt.value;
  if (disabled.value || !previous?.undo) return;
  const id = generation, userId = owner.value;
  pending.value = true; error.value = ''; notice.value = ''; receipt.value = null;
  try {
    const refreshed = await cart.refreshServer();
    if (!current(id, userId)) return;
    if (!refreshed) { loadError.value = 'Не удалось проверить актуальную корзину. Нажмите «Обновить».'; return; }
    const before = cart.quoteLine(previous.productId), change = quickShopUndo(previous.undo, before);
    if (!change) { error.value = 'Этот товар уже изменился. Проверьте его количество: возврат отменён.'; return; }
    const changed = await cart.changeServer(change);
    if (!current(id, userId)) return;
    if (!changed) { await unconfirmedChange(id, userId); return; }
    const after = cart.quoteLine(previous.productId), product = after?.product ?? before?.product ?? previous.undo.before?.product;
    if (product) receipt.value = { productId: previous.productId, text: `Возврат выполнен. ${quickShopChange(product, before, after)}`, undo: null };
  } finally { if (current(id, userId)) pending.value = false; }
}
async function repeatLast() {
  if (disabled.value || !repeatOrderId.value) return;
  const id = generation, userId = owner.value;
  pending.value = true; repeating.value = true; error.value = ''; notice.value = ''; receipt.value = null;
  try {
    const result = await cart.repeatServer(repeatOrderId.value);
    if (!current(id, userId)) return;
    if (!result) { error.value = 'Результат повторения не подтверждён. Товары могли уже добавиться: проверьте корзину перед повторным действием.'; return; }
    repeatResult.value = result;
    filter.value = 'cart'; query.value = '';
    notice.value = `Заказ №${result.orderId}: добавлено позиций ${result.added}. Проверьте количество и текущие цены.`;
  } finally { if (current(id, userId)) { pending.value = false; repeating.value = false; } }
}
</script>

<style scoped>
.quick-shop { min-height: 100dvh; background: var(--ui-bg); color: var(--ui-text); padding-bottom: calc(8.5rem + env(safe-area-inset-bottom, 0px)); }
.quick-shop__header, .quick-shop__main, .quick-shop__cart-inner { width: min(100%, 45rem); margin-inline: auto; padding-inline: clamp(0.875rem, 4vw, 1.5rem); box-sizing: border-box; }
.quick-shop__header { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; min-height: 5rem; padding-top: env(safe-area-inset-top, 0px); border-bottom: 1px solid var(--ui-border); }
.quick-shop__brand { min-width: 0; font-size: 1.0625rem; font-weight: 750; letter-spacing: -0.035em; }
.quick-shop__brand span { display: block; margin-top: 0.125rem; font-size: 0.6875rem; font-weight: 400; letter-spacing: 0; color: var(--ui-text-muted); }
.quick-shop__header :deep(a) { min-height: 2.75rem; }
.quick-shop__title-row { padding-block: 1.5rem 1.25rem; }
.quick-shop__title-row h1 { font-size: clamp(1.625rem, 5vw, 2.125rem); font-weight: 750; line-height: 1.15; letter-spacing: -0.035em; }
.quick-shop__title-row p { margin-top: 0.5rem; font-size: 0.875rem; color: var(--ui-text-muted); }
.quick-shop__repeat { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; padding: 1rem; border: 1px solid var(--ui-border); border-radius: 1rem; background: var(--ui-bg-elevated); }
.quick-shop__repeat h2, .quick-shop__review h2 { font-size: 0.9375rem; font-weight: 650; }
.quick-shop__repeat p { margin-top: 0.25rem; font-size: 0.75rem; color: var(--ui-text-muted); }
.quick-shop__repeat :deep(button) { min-height: 2.75rem; }
.quick-shop__repeat-hint { grid-column: 1 / -1; line-height: 1.5; }
.quick-shop__review { display: grid; justify-items: start; gap: 0.625rem; padding: 1rem; margin-top: 0.875rem; border: 1px solid var(--ui-border); border-radius: 1rem; }
.quick-shop__review p, .quick-shop__review li { font-size: 0.8125rem; line-height: 1.5; }
.quick-shop__review ul { display: grid; gap: 0.375rem; padding-left: 1rem; list-style: disc; }
.quick-shop__search { display: flex; align-items: center; gap: 0.625rem; margin-top: 1.25rem; padding: 0.5rem 0.75rem; border: 1px solid var(--ui-border-accented); border-radius: 0.875rem; background: var(--ui-bg); }
.quick-shop__search > :deep(svg) { width: 1.25rem; height: 1.25rem; color: var(--ui-text-muted); flex: none; }
.quick-shop__search input { width: 100%; min-width: 0; min-height: 2rem; border: 0; background: transparent; font-size: 1rem; color: var(--ui-text); }
.quick-shop__search input:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 3px; border-radius: 0.25rem; }
.quick-shop__search button { display: grid; place-items: center; flex: none; width: 2.75rem; min-height: 2.75rem; border: 0; background: none; color: var(--ui-text-muted); cursor: pointer; }
.quick-shop__tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 0.375rem; margin-top: 1rem; }
.quick-shop__tabs button { min-height: 2.75rem; padding: 0.625rem 0.875rem; border: 1px solid var(--ui-border); border-radius: 2rem; background: var(--ui-bg); color: var(--ui-text-muted); font-size: 0.8125rem; cursor: pointer; }
.quick-shop__tabs button[aria-pressed="true"] { border-color: var(--ui-primary); background: var(--ui-primary); color: var(--ui-text-inverted); }
.quick-shop__tabs button:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.quick-shop__list-heading { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding-top: 1.125rem; }
.quick-shop__list-heading h2 { font-size: 1.0625rem; font-weight: 650; }
.quick-shop__list-heading :deep(button) { min-height: 2.75rem; }
.quick-shop__state, .quick-shop__restore { padding-block: 1rem; color: var(--ui-text-muted); font-size: 0.875rem; }
.quick-shop__restore { display: grid; justify-items: start; gap: 0.625rem; }
.quick-shop__alert { margin-block: 0.75rem; }
.quick-shop__notice { margin-top: 0.75rem; padding: 0.75rem; border-radius: 0.75rem; background: var(--ui-bg-elevated); font-size: 0.8125rem; line-height: 1.5; font-variant-numeric: tabular-nums; }
.quick-shop__empty { display: grid; justify-items: center; gap: 0.875rem; padding: 2.5rem 1rem; text-align: center; color: var(--ui-text-muted); font-size: 0.875rem; }
.quick-shop__empty > :deep(svg) { width: 2rem; height: 2rem; }
.quick-shop__footnote { margin-top: 1.25rem; color: var(--ui-text-muted); font-size: 0.75rem; line-height: 1.55; }
.quick-shop__signin { display: grid; justify-items: start; gap: 1rem; padding-block: 1rem; }
.quick-shop__signin h2 { font-size: 1.125rem; font-weight: 650; }
.quick-shop__signin p { font-size: 0.875rem; color: var(--ui-text-muted); line-height: 1.55; }
.quick-shop__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.quick-shop__cart { position: fixed; bottom: 0; left: 0; right: 0; z-index: 30; padding-block: 0.875rem calc(0.875rem + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--ui-border); background: var(--ui-bg); box-shadow: 0 -0.25rem 1.5rem color-mix(in srgb, var(--ui-text) 5%, transparent); }
.quick-shop__cart-inner { display: flex; align-items: center; justify-content: space-between; gap: 0.875rem; }
.quick-shop__cart-copy { display: grid; min-width: 0; gap: 0.125rem; }
.quick-shop__cart-copy span { font-size: 0.75rem; color: var(--ui-text-muted); }
.quick-shop__cart-copy strong { font-size: clamp(1rem, 4vw, 1.375rem); font-variant-numeric: tabular-nums; font-weight: 700; overflow-wrap: anywhere; }
.quick-shop__cart-copy small { font-size: 0.6875rem; color: var(--ui-text-muted); }
.quick-shop__cart-inner :deep(a), .quick-shop__cart-inner :deep(button) { flex: none; justify-content: center; min-height: 2.875rem; }
@media (max-width: 24rem) { .quick-shop__tabs button { padding-inline: 0.75rem; font-size: 0.75rem; } .quick-shop__cart-inner { flex-wrap: wrap; gap: 0.625rem; } .quick-shop__cart-copy { flex: 1; } .quick-shop__cart-inner :deep(a), .quick-shop__cart-inner :deep(button) { font-size: 0.8125rem; } }
</style>
