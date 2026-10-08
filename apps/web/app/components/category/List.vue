<template>
  <div class="categories" :class="{ 'categories--tracked': active !== undefined }">
    <UModal v-model:open="open" title="Все категории" description="Выберите категорию или найдите её по названию" :content="{ onOpenAutoFocus: focusSearch }" :ui="{ content: 'categories__dialog top-auto inset-x-0 bottom-0 translate-x-0 translate-y-0 w-full max-w-none rounded-t-xl sm:top-1/2 sm:left-1/2 sm:bottom-auto sm:right-auto sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[calc(100vw-2rem)] sm:max-w-lg sm:rounded-lg', overlay: 'categories__overlay', body: 'categories__body' }">
      <UButton class="categories__toggle" type="button" icon="i-lucide-layout-grid" color="neutral" variant="soft" aria-label="Все категории" :aria-expanded="open" aria-haspopup="dialog" />
      <template #close><UButton type="button" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Закрыть категории" /></template>
      <template #body>
        <div ref="panel" class="categories__panel">
          <div class="categories__search">
            <UInput v-model="search" icon="i-lucide-search" placeholder="Найти категорию" aria-label="Поиск категорий" maxlength="160" class="categories__input" />
            <UButton v-if="search" type="button" icon="i-lucide-x" variant="ghost" color="neutral" aria-label="Очистить поиск категорий" @click="search = ''; focusInput()" />
          </div>
          <nav class="categories__grid" aria-label="Полный список категорий">
            <NuxtLink v-if="!search.trim() || 'все'.includes(search.trim().toLocaleLowerCase('ru-RU'))" :to="link('/catalog')" class="categories__card" :class="{ 'categories__card--active': active === '' }" :aria-current="current('')" @click="chooseCategory($event, '')">Все товары</NuxtLink>
            <NuxtLink v-for="item in filtered" :key="item.id" :to="link(`/catalog/${item.slug}`)" class="categories__card" :class="{ 'categories__card--active': active === item.slug }" :aria-current="current(item.slug)" @click="chooseCategory($event, item.slug)">{{ item.name }}</NuxtLink>
          </nav>
          <p v-if="search.trim() && !filtered.length && !'все'.includes(search.trim().toLocaleLowerCase('ru-RU'))" class="categories__empty" role="status">Категории не найдены</p>
        </div>
      </template>
    </UModal>
    <nav ref="nav" class="categories__strip" aria-label="Категории товаров">
      <NuxtLink :to="link('/catalog')" class="categories__item" :class="{ 'categories__item--active': active === '' }" :aria-current="current('')" @click="chooseCategory($event, '')">Все</NuxtLink>
      <NuxtLink v-for="item in items" :key="item.id" :to="link(`/catalog/${item.slug}`)" class="categories__item" :class="{ 'categories__item--active': active === item.slug }" :aria-current="current(item.slug)" @click="chooseCategory($event, item.slug)">{{ item.name }}</NuxtLink>
    </nav>
    <slot name="trailing">
      <ProductSort v-if="sort" :model-value="sort" @update:model-value="emit('update:sort', $event)" />
    </slot>
  </div>
</template>

<script setup lang="ts">
import type { Category } from '~/types/category';
import type { ProductSort } from '~/types/product';
const props = defineProps<{ items: Category[]; query?: Record<string, string>; active?: string; sort?: ProductSort }>();
const emit = defineEmits<{ choose: [slug: string]; 'update:sort': [value: ProductSort] }>();
const nav = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const open = ref(false);
const search = ref('');
const filtered = computed(() => {
  const value = search.value.trim().toLocaleLowerCase('ru-RU');
  return props.items.filter(item => item.name.toLocaleLowerCase('ru-RU').includes(value));
});
function current(slug: string) {
  return props.active === undefined ? undefined : props.active === slug ? 'page' : 'false';
}
function link(path: string) { return props.query ? { path, query: props.query } : path; }
function chooseCategory(event: MouseEvent, slug: string) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  open.value = false;
  emit('choose', slug);
}
function revealActive() {
  const strip = nav.value, tab = strip?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!strip || !tab) return;
  const outer = strip.getBoundingClientRect(), inner = tab.getBoundingClientRect();
  if (inner.left >= outer.left && inner.right <= outer.right) return;
  strip.scrollTo({ left: strip.scrollLeft + inner.left - outer.left - (strip.clientWidth - inner.width) / 2,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}
function fitPanel() {
  const dialog = panel.value?.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) return;
  const viewport = window.visualViewport;
  dialog.style.setProperty('--categories-height', (viewport?.height ?? window.innerHeight) + 'px');
  dialog.style.setProperty('--categories-keyboard', Math.max(0, window.innerHeight - (viewport ? viewport.height + viewport.offsetTop : window.innerHeight)) + 'px');
}
function focusInput() { panel.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }); }
function focusSearch(event: Event) { event.preventDefault(); void nextTick(() => { fitPanel(); focusInput(); }); }
onMounted(() => {
  revealActive();
  window.visualViewport?.addEventListener('resize', fitPanel);
  window.visualViewport?.addEventListener('scroll', fitPanel);
});
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener('resize', fitPanel);
  window.visualViewport?.removeEventListener('scroll', fitPanel);
});
watch(() => props.active, revealActive, { flush: 'post' });
watch(open, value => { if (!value) search.value = ''; });
</script>

<style scoped>
.categories { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.categories__strip { display: flex; flex: 1; min-width: 0; justify-content: flex-start; gap: 0.5rem; overflow-x: auto; overscroll-behavior-inline: contain; scrollbar-width: thin; padding-block: 0.125rem; }
.categories__item { display: inline-flex; min-height: var(--touch-target); align-items: center; flex: none; padding: 0.6rem 1rem; border: 1px solid var(--ui-border); border-radius: 999px; background: var(--ui-bg-elevated); font-weight: 500; white-space: nowrap; transition: background-color 0.2s, border-color 0.2s, color 0.2s; }
.categories__item:hover { border-color: var(--ui-primary); color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg-elevated)); }
.categories:not(.categories--tracked) .categories__item.router-link-exact-active, .categories__item--active { border-color: var(--ui-primary); color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg-elevated)); }
.categories__item:focus-visible, .categories__card:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.categories__toggle { flex: none; width: var(--touch-target); height: var(--touch-target); padding: 0; }
.categories__search { display: flex; align-items: center; gap: 0.25rem; margin-bottom: 0.75rem; }
.categories__input { min-width: 0; flex: 1; }
.categories__input :deep(input) { font-size: 1rem; }
.categories__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
.categories__card { display: flex; align-items: center; min-height: var(--touch-target); padding: 0.75rem; border: 1px solid var(--ui-border); border-radius: 0.5rem; font-size: 0.875rem; overflow-wrap: anywhere; }
.categories__card--active { color: var(--ui-primary); border-color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 10%, var(--ui-bg)); }
.categories__empty { padding-block: 1rem; color: var(--ui-text-muted); }
:global(.categories__dialog) { z-index: 101; max-height: min(88dvh, calc(var(--categories-height, 100dvh) - 1rem)); }
:global(.categories__overlay) { z-index: 100; }
:global(.categories__body) { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: max(1rem, env(safe-area-inset-bottom)); }
@media (width < 40rem) {
  :global(.categories__dialog) { bottom: var(--categories-keyboard, 0px); }
}
</style>
