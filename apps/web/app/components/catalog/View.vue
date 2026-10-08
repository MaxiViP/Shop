<template>
  <UContainer class="catalog" :data-loaded-count="items.length">
    <div class="catalog__head">
      <AppBreadcrumbs :items="breadcrumbs" />
      <p class="catalog__total" role="status">Найдено: {{ total }}</p>
    </div>
    <h1 class="sr-only">{{ title }}</h1>

    <div ref="navigation" class="catalog__navigation" :style="{ top: `${headerOffset}px` }">
      <CategoryList v-model:sort="sort" class="catalog__categories" :items="categories" :query="categoryQuery" :active="activeCategory" @choose="chooseCategory" />
    </div>

    <form class="catalog__search" role="search" @submit.prevent="submitSearch">
      <UInput v-model="search" class="catalog__search-input" icon="i-lucide-search" placeholder="Поиск продуктов" aria-label="Поиск продуктов" maxlength="100" size="lg" />
      <UButton v-if="search" class="catalog__clear" type="button" icon="i-lucide-x" variant="ghost" color="neutral" aria-label="Очистить поиск" @click="clearSearch" />
      <UButton class="catalog__submit" type="submit" size="lg">Найти</UButton>
    </form>

    <ProductSkeleton v-if="status === 'pending'" />
    <div v-else-if="error && !items.length" class="catalog__error" role="alert">
      <UAlert title="Не удалось загрузить товары" color="error" />
      <UButton type="button" variant="soft" @click="retry">Повторить</UButton>
    </div>
    <template v-else>
      <div v-if="groups.length" ref="groupList" class="catalog__groups">
        <section v-for="group in groups" :key="group.key" class="catalog__group" :data-category="group.key">
          <h2 class="catalog__group-title">{{ group.label }}</h2>
          <ProductGrid :items="group.items" :windowed="items.length > 120" />
        </section>
      </div>
      <ProductGrid v-else-if="items.length" :items="items" :windowed="items.length > 120" />
      <div v-else class="catalog__empty">
        <h2 class="catalog__empty-title">Ничего не найдено</h2>
        <UButton v-if="q" type="button" variant="soft" @click="clearSearch">Очистить поиск</UButton>
      </div>
      <ProductMore v-if="items.length || hasMore" :has-more="hasMore" :loading="loadingMore" :error="!!error" :stale="stale" @load="loadMore" @retry="retry" />
    </template>
  </UContainer>
</template>

<script setup lang="ts">
import type { Category } from '~/types/category';
import { useCatalog } from '~/composables/useCatalog';
import { visibleCategory } from '~/utils/catalog';

const { title, category = undefined, categories } = defineProps<{
  title: string;
  category?: string;
  categories: Category[];
}>();
const router = useRouter();
const activeCategory = ref(category ?? '');
const navigation = ref<HTMLElement | null>(null);
const groupList = ref<HTMLElement | null>(null);
const headerOffset = ref(64);
let frame = 0;

function trackCategory() {
  frame = 0;
  const header = document.querySelector<HTMLElement>('header.header');
  const cart = document.querySelector<HTMLElement>('.floating-cart-anchor--visible');
  const offset = Math.max(0, header?.getBoundingClientRect().bottom ?? 0, cart?.getBoundingClientRect().bottom ?? 0);
  if (offset !== headerOffset.value) { headerOffset.value = offset; void nextTick(scheduleTrack); return; }
  if (!category || !groupList.value) return;
  const anchor = (navigation.value?.getBoundingClientRect().bottom ?? 0) + 8;
  const bounds = [...groupList.value.querySelectorAll<HTMLElement>('[data-category]')].flatMap(section => {
    const grid = section.querySelector<HTMLElement>('.grid');
    if (!grid || !section.dataset.category) return [];
    const { top, bottom } = grid.getBoundingClientRect();
    return [{ slug: section.dataset.category, top, bottom }];
  });
  const current = visibleCategory(bounds, anchor, window.innerHeight);
  if (current) activeCategory.value = current;
}
function scheduleTrack() {
  if (!frame) frame = requestAnimationFrame(trackCategory);
}
let headerObserver: MutationObserver | undefined;
onMounted(() => {
  window.addEventListener('scroll', scheduleTrack, { passive: true });
  window.addEventListener('resize', scheduleTrack, { passive: true });
  scheduleTrack();
  const header = document.querySelector('header.header');
  if (header) {
    headerObserver = new MutationObserver(scheduleTrack);
    headerObserver.observe(header, { attributes: true, attributeFilter: ['class'] });
    const cart = document.querySelector('.floating-cart-anchor');
    if (cart) headerObserver.observe(cart, { attributes: true, attributeFilter: ['class'] });
    header.addEventListener('transitionend', scheduleTrack);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', scheduleTrack);
  window.removeEventListener('resize', scheduleTrack);
  cancelAnimationFrame(frame);
  headerObserver?.disconnect();
  document.querySelector('header.header')?.removeEventListener('transitionend', scheduleTrack);
});

const { search, q, sort, categoryQuery, items, groups, total, status, error, stale, loadingMore,
  hasMore, submitSearch, clearSearch, loadMore, retry, restart } = await useCatalog(category);
const breadcrumbs = computed(() => [
  { label: 'Главная', to: '/' },
  { label: 'Каталог', to: router.resolve({ path: '/catalog', query: categoryQuery.value }).href },
  ...(category ? [{ label: title, to: router.resolve({ path: '/catalog/' + encodeURIComponent(category), query: categoryQuery.value }).href }] : []),
]);
watch(() => groups.value.map(group => group.key).join(','), () => {
  if (import.meta.client) scheduleTrack();
}, { flush: 'post' });
watch(status, value => { if (value === 'pending') activeCategory.value = category ?? ''; });

async function chooseCategory(slug: string) {
  activeCategory.value = slug;
  if (slug === (category ?? '')) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await restart();
  }
}
</script>

<style scoped>
:global(html:has(.catalog)), :global(body:has(.catalog)), :global(#__nuxt:has(.catalog)) { min-width: 0; }
.catalog { min-width: 0; padding-block: 0 var(--page-end); }
.catalog__head { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.catalog__head :deep(.breadcrumbs) { flex: 1; margin-bottom: 0; }
.catalog__head :deep(.breadcrumbs__list) { flex-wrap: nowrap; }
.catalog__head :deep(.breadcrumbs__item) { flex: none; white-space: nowrap; }
.catalog__head :deep(.breadcrumbs__item:last-child) { flex: 0 1 auto; overflow: hidden; }
.catalog__head :deep([aria-current="page"]) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.catalog__head :deep([aria-hidden="true"]) { flex: none; }
.catalog__navigation { position: sticky; top: var(--header-height); z-index: 20; padding-block: 0.25rem; margin-bottom: 0.75rem; background: var(--ui-bg); }
.catalog__search { display: flex; gap: 0.5rem; width: 100%; min-width: 0; max-width: 42.5rem; margin-bottom: 1rem; }
.catalog__search-input { flex: 1; min-width: 0; min-height: var(--touch-target); }
.catalog__search :deep(input) { font-size: 1rem; }
.catalog__clear, .catalog__submit { min-width: var(--touch-target); min-height: var(--touch-target); }
.catalog__total { flex: none; margin-left: auto; color: var(--ui-text-muted); font-size: 0.75rem; white-space: nowrap; }
.catalog__groups { display: grid; gap: 1.75rem; }
.catalog__groups:has(.grid[data-windowed]) { overflow-anchor: none; }
.catalog__group-title { margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--ui-border); font-size: 1.125rem; font-weight: 600; }
.catalog__empty { display: grid; justify-items: start; gap: 1rem; padding-block: 3rem; }
.catalog__empty-title { font-size: var(--section-title); font-weight: 600; }
.catalog__error { display: grid; justify-items: start; gap: 0.75rem; }
@media (width < 48rem) { .catalog__search { display: none; } }
@media (min-width: 40rem) { .catalog__total { font-size: 0.875rem; } }
</style>
