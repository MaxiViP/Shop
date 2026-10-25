<template>
  <div class="categories" :class="{ 'categories--tracked': active !== undefined }">
    <UModal v-model:open="open" title="Все категории" description="Выберите категорию или найдите её по названию" :content="{ onOpenAutoFocus: focusPanel }" :ui="{ content: 'categories__dialog top-auto inset-x-0 bottom-0 translate-x-0 translate-y-0 w-full max-w-none rounded-t-xl sm:top-1/2 sm:left-1/2 sm:bottom-auto sm:right-auto sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[calc(100vw-2rem)] sm:max-w-lg sm:rounded-lg', overlay: 'categories__overlay', body: 'categories__body', footer: 'categories__footer' }">
      <UButton class="categories__toggle" type="button" icon="i-lucide-layout-grid" color="neutral" variant="soft" aria-label="Все категории" :aria-expanded="open" aria-haspopup="dialog" />
      <template #close><UButton type="button" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Закрыть категории" /></template>
      <template #body>
        <div ref="panel" class="categories__panel">
          <nav class="categories__grid" aria-label="Полный список категорий">
            <NuxtLink v-if="!search.trim() || 'все'.includes(search.trim().toLocaleLowerCase('ru-RU'))" :to="link('/catalog')" class="categories__card" :class="{ 'categories__card--active': active === '' && !route.query.marketPoint }" :aria-current="current('')" @click="chooseCategory($event, '')">Все товары</NuxtLink>
            <NuxtLink v-for="point in filteredPoints" :key="'point-' + point.id" :to="pointLink(point.slug)" class="categories__card" :style="{ borderColor: point.cardColor ?? undefined }" :aria-current="route.query.marketPoint === point.slug ? 'page' : undefined" @click="open = false">{{ point.name }}</NuxtLink>
            <NuxtLink v-for="item in filtered" :key="item.id" :to="link(`/catalog/${item.slug}`)" class="categories__card" :class="{ 'categories__card--active': active === item.slug }" :aria-current="current(item.slug)" @click="chooseCategory($event, item.slug)">{{ item.name }}</NuxtLink>
          </nav>
          <p v-if="search.trim() && !filtered.length && !filteredPoints.length && !'все'.includes(search.trim().toLocaleLowerCase('ru-RU'))" class="categories__empty" role="status">Категории не найдены</p>
        </div>
      </template>
      <template #footer>
        <div ref="searchBar" class="categories__search" :class="{ 'categories__search--open': searchOpen }">
          <div class="categories__search-field" :inert="!searchOpen" :aria-hidden="!searchOpen">
            <UInput v-model="search" placeholder="Найти категорию" aria-label="Поиск категорий" maxlength="160" :tabindex="searchOpen ? 0 : -1" class="categories__input" :ui="{ base: 'pe-14' }">
              <template #trailing>
                <UButton type="button" icon="i-lucide-x" variant="ghost" color="neutral" class="categories__search-clear" aria-label="Закрыть поиск категорий" @click="closeSearch" />
              </template>
            </UInput>
          </div>
          <UButton type="button" icon="i-lucide-search" variant="soft" color="neutral" class="categories__search-toggle" :aria-label="searchOpen ? 'Свернуть поиск категорий' : 'Открыть поиск категорий'" :aria-expanded="searchOpen" @click="toggleSearch" />
        </div>
      </template>
    </UModal>
    <div class="categories__scroller">
      <nav ref="nav" class="categories__strip" aria-label="Категории товаров" @focusin="revealFocused">
        <NuxtLink :to="link('/catalog')" class="categories__item" :class="{ 'categories__item--active': active === '' && !route.query.marketPoint }" :aria-current="current('')" @click="chooseCategory($event, '')">Все</NuxtLink>
        <NuxtLink v-for="point in points" :key="'point-' + point.id" :to="pointLink(point.slug)" class="categories__item" :class="{ 'categories__item--active': route.query.marketPoint === point.slug }" :style="{ borderColor: point.cardColor ?? undefined }" :title="point.name" :aria-current="route.query.marketPoint === point.slug ? 'page' : undefined"><span class="categories__label">{{ point.name }}</span></NuxtLink>
        <NuxtLink v-for="item in items" :key="item.id" :to="link(`/catalog/${item.slug}`)" class="categories__item" :class="{ 'categories__item--active': active === item.slug }" :aria-current="current(item.slug)" :title="item.name" @click="chooseCategory($event, item.slug)"><span class="categories__label">{{ item.name }}</span></NuxtLink>
      </nav>
    </div>
    <div class="categories__trailing">
      <slot name="trailing">
        <ProductSort v-if="sort" :model-value="sort" @update:model-value="emit('update:sort', $event)" />
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Category } from '~/types/category';
import type { ProductSort } from '~/types/product';
const props = defineProps<{ items: Category[]; query?: Record<string, string>; active?: string; sort?: ProductSort }>();
const emit = defineEmits<{ choose: [slug: string]; 'update:sort': [value: ProductSort] }>();
const route = useRoute();
type CatalogPoint = { id: number; slug: string; name: string; cardColor: string | null; isOurPoint: boolean };
const { data: points } = await useApi<CatalogPoint[]>('/categories/points', { default: () => [] });
const filteredPoints = computed(() => points.value.filter(point => point.name.toLocaleLowerCase('ru-RU').includes(search.value.trim().toLocaleLowerCase('ru-RU'))));
function pointLink(slug: string) { return { path: '/catalog', query: { ...props.query, marketPoint: slug } }; }
const nav = ref<HTMLElement | null>(null);
let stripObserver: ResizeObserver | undefined;
const panel = ref<HTMLElement | null>(null);
const searchBar = ref<HTMLElement | null>(null);
const open = ref(false);
const searchOpen = ref(false);
const search = ref('');
const filtered = computed(() => {
  const value = search.value.trim().toLocaleLowerCase('ru-RU');
  return props.items.filter(item => item.name.toLocaleLowerCase('ru-RU').includes(value));
});
function current(slug: string) {
  if (route.query.marketPoint && !slug) return 'false';
  return props.active === undefined ? undefined : props.active === slug ? 'page' : 'false';
}
function link(path: string) {
  const { marketPoint: _point, ...query } = props.query ?? {};
  return { path, query };
}
function chooseCategory(event: MouseEvent, slug: string) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  open.value = false;
  emit('choose', slug);
}
function revealTab(tab: HTMLElement) {
  const strip = nav.value;
  if (!strip) return;
  const outer = strip.getBoundingClientRect(), inner = tab.getBoundingClientRect();
  const style = getComputedStyle(strip);
  const left = outer.left + parseFloat(style.paddingLeft), right = outer.right - parseFloat(style.paddingRight);
  if (inner.left >= left - 1 && inner.right <= right + 1) return;
  strip.scrollTo({ left: strip.scrollLeft + inner.left - left - (right - left - inner.width) / 2,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}
function revealActive() {
  const tab = nav.value?.querySelector<HTMLElement>('[aria-current="page"]');
  if (tab) revealTab(tab);
}
function revealFocused(event: FocusEvent) {
  if (event.target instanceof HTMLElement && event.target.classList.contains('categories__item')) revealTab(event.target);
}
function fitPanel() {
  const dialog = panel.value?.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) return;
  const viewport = window.visualViewport;
  dialog.style.setProperty('--categories-height', (viewport?.height ?? window.innerHeight) + 'px');
  dialog.style.setProperty('--categories-center', ((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) / 2) + 'px');
  dialog.style.setProperty('--categories-keyboard', Math.max(0, window.innerHeight - (viewport ? viewport.height + viewport.offsetTop : window.innerHeight)) + 'px');
}
function resetSearch() {
  searchBar.value?.querySelector<HTMLInputElement>('input')?.blur();
  searchOpen.value = false;
  search.value = '';
}
function closeSearch() {
  resetSearch();
  searchBar.value?.querySelector<HTMLButtonElement>('.categories__search-toggle')?.focus({ preventScroll: true });
}
function toggleSearch() {
  if (searchOpen.value) return closeSearch();
  searchOpen.value = true;
  const field = searchBar.value?.querySelector<HTMLElement>('.categories__search-field');
  // Focus inside the tap event so mobile browsers can open the keyboard.
  if (field) field.inert = false;
  searchBar.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
}
function focusPanel(event: Event) {
  event.preventDefault();
  void nextTick(() => {
    const dialog = panel.value?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog || !open.value) return;
    fitPanel();
    dialog.style.removeProperty('--categories-open-height');
    dialog.style.setProperty('--categories-open-height', dialog.offsetHeight + 'px');
    dialog.focus({ preventScroll: true });
  });
}
onMounted(() => {
  revealActive();
  stripObserver = new ResizeObserver(revealActive);
  if (nav.value) stripObserver.observe(nav.value);
  window.visualViewport?.addEventListener('resize', fitPanel);
  window.visualViewport?.addEventListener('scroll', fitPanel);
  window.addEventListener('resize', fitPanel);
});
onBeforeUnmount(() => {
  stripObserver?.disconnect();
  window.visualViewport?.removeEventListener('resize', fitPanel);
  window.visualViewport?.removeEventListener('scroll', fitPanel);
  window.removeEventListener('resize', fitPanel);
});
watch(() => [props.active, route.query.marketPoint, props.items, points.value], () => {
  revealActive();
}, { flush: 'post', deep: true });
watch(open, value => { if (!value) resetSearch(); });
</script>

<style scoped>
.categories {
  --categories-edge: var(--page-x);
  --categories-inset: calc(var(--categories-edge) + var(--touch-target) + 0.75rem);
  position: relative;
  isolation: isolate;
  container-type: inline-size;
  width: calc(100% + 2 * var(--page-x));
  min-width: 0;
  margin-inline: calc(-1 * var(--page-x));
  background: var(--ui-bg);
}
.categories__scroller { position: relative; min-width: 0; }
.categories__scroller::before, .categories__scroller::after {
  content: '';
  position: absolute;
  inset-block: 0;
  z-index: 1;
  width: var(--categories-inset);
  pointer-events: none;
}
.categories__scroller::before { left: 0; background: linear-gradient(to right, var(--ui-bg) calc(100% - 0.75rem), transparent); }
.categories__scroller::after { right: 0; background: linear-gradient(to left, var(--ui-bg) calc(100% - 0.75rem), transparent); }
.categories__strip { display: flex; min-width: 0; gap: 0.5rem; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-width: none; padding: 0.375rem var(--categories-inset); scroll-padding-inline: var(--categories-inset); }
.categories__strip::-webkit-scrollbar { display: none; }
.categories__item { display: inline-flex; min-height: var(--touch-target); align-items: center; flex: none; max-width: min(20rem, calc(100cqw - 2 * var(--categories-inset))); padding: 0.6rem 1rem; border: 1px solid var(--ui-border); border-radius: 999px; background: var(--ui-bg-elevated); font-weight: 500; white-space: nowrap; transition: background-color 0.2s, border-color 0.2s, color 0.2s; }
.categories__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.categories__item:hover { border-color: var(--ui-primary); color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg-elevated)); }
.categories:not(.categories--tracked) .categories__item.router-link-exact-active, .categories__item--active { border-color: var(--ui-primary); color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg-elevated)); }
.categories__item:focus-visible, .categories__card:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.categories__toggle { position: absolute; top: 50%; left: var(--categories-edge); z-index: 2; transform: translateY(-50%); border: 1px solid var(--search-background); width: var(--touch-target); height: var(--touch-target); padding: 0; border-radius: 0.875rem; background: var(--ui-bg-elevated); box-shadow: 0 4px 12px light-dark(#0f172a18, #0004); }
.categories__trailing { position: absolute; top: 50%; right: var(--categories-edge); z-index: 2; display: flex; align-items: center; transform: translateY(-50%); }
.categories__search { display: grid; width: 100%; min-width: 0; grid-template-columns: minmax(0, 1fr) var(--touch-target); align-items: center; gap: 0.25rem; }
.categories__search-field { width: 0; min-width: 0; justify-self: end; overflow: hidden; opacity: 0; transition: width 200ms ease, opacity 200ms ease; }
.categories__search--open .categories__search-field { width: 100%; opacity: 1; }
.categories__input { width: 100%; min-width: 0; }
.categories__input :deep(input) { min-height: var(--touch-target); font-size: 1rem; }
.categories__search-toggle, .categories__search-clear { width: var(--touch-target); height: var(--touch-target); padding: 0; }
.categories__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
.categories__card { display: flex; align-items: center; min-height: var(--touch-target); padding: 0.75rem; border: 1px solid var(--ui-border); border-radius: 0.5rem; font-size: 0.875rem; overflow-wrap: anywhere; }
.categories__card--active { color: var(--ui-primary); border-color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 10%, var(--ui-bg)); }
.categories__empty { padding-block: 1rem; color: var(--ui-text-muted); }
:global(.categories__dialog) { z-index: 101; height: var(--categories-open-height, auto); max-height: min(88dvh, calc(var(--categories-height, 100dvh) - 1rem)); }
:global(.categories__overlay) { z-index: 100; }
:global(.categories__body) { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 1rem; }
:global(.categories__footer) { flex: none; padding: 0.75rem max(1rem, var(--safe-right)) max(0.75rem, var(--safe-bottom)) max(1rem, var(--safe-left)); }
@media (width < 40rem) {
  :global(.categories__dialog) { bottom: var(--categories-keyboard, 0px); }
}
@media (width >= 40rem) {
  :global(.categories__dialog) { top: var(--categories-center, 50%); }
}
@media (prefers-reduced-motion: reduce) {
  .categories__search-field { transition: none; }
}
</style>
