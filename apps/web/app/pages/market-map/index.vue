<template>
  <UContainer class="market-map">
    <AppBreadcrumbs :items="breadcrumbs" />
    <header class="market-map__intro">
      <div>
        <p class="market-map__eyebrow">Багратионовский рынок · 2 этаж</p>
        <h1 class="market-map__title">Карта рынка</h1>
      </div>
      <p class="market-map__lead">Посмотрите лавки, магазины и фудкорт заранее. Выберите нужного продавца — это поможет быстрее собрать заказ и сориентироваться при самовывозе.</p>
    </header>
    <UAlert v-if="error" color="error" title="Не удалось загрузить карту рынка" :description="apiError(error)">
      <template #actions><UButton variant="outline" color="error" @click="refresh()">Попробовать снова</UButton></template>
    </UAlert>
    <template v-else>
      <div class="market-map__filters">
        <UFormField label="Найти точку" class="market-map__search">
          <UInput v-model="query" icon="i-lucide-search" placeholder="Название, номер или ассортимент" class="w-full" maxlength="160" />
        </UFormField>
        <UFormField label="Что ищете">
          <USelect v-model="kind" :items="kinds" class="w-full" />
        </UFormField>
      </div>
      <div class="market-map__layout">
        <MarketMap :points="mapPoints" :selected-id="focused?.id" />
        <section class="market-map__directory" aria-labelledby="market-points">
          <h2 id="market-points" class="market-map__heading">{{ query.trim() || kindFilter ? 'Найденные точки' : 'Лавки и магазины' }} <span class="market-map__count">{{ visible.length }}</span></h2>
          <p v-if="!points.length" class="market-map__empty">Список лавок готовится. Скоро здесь появятся опубликованные точки рынка.</p>
          <div v-else-if="!visible.length" class="market-map__empty" role="status">
            <p>Точки не найдены. Попробуйте другое название или тип.</p>
            <UButton variant="link" @click="resetFilters">Сбросить поиск</UButton>
          </div>
          <ul v-else class="market-map__list">
            <li v-for="point in visible" :key="point.id">
              <NuxtLink :to="`/market-map/${point.slug}`" class="market-map__card">
                <span class="market-map__card-type">{{ marketKindLabels[point.kind] }}<span v-if="point.unitNumber"> · {{ point.unitNumber }}</span></span>
                <span class="market-map__card-name">{{ point.name }}</span>
                <span v-if="point.sampleAssortment" class="market-map__card-note">{{ point.sampleAssortment }}</span>
                <UIcon name="i-lucide-arrow-up-right" class="market-map__card-arrow" aria-hidden="true" />
              </NuxtLink>
            </li>
          </ul>
        </section>
      </div>
      <p v-if="entrances.length" class="market-map__entrances"><UIcon name="i-lucide-log-in" aria-hidden="true" />На схеме отмечены входы на 2 этаж. Это поможет выбрать подходящий путь при самовывозе.</p>
    </template>
    <section class="market-map__about" aria-labelledby="market-digital">
      <div>
        <h2 id="market-digital" class="market-map__heading">Аутентичный поход на рынок — в цифровом виде</h2>
        <p>Вы можете заранее выбрать нужную лавку и указать её в комментарии к заказу. Ассортимент меняется в течение дня: продавец может показать актуальный прилавок по фото и уточнить ваш выбор в прямом чате заказа онлайн.</p>
      </div>
      <ul class="market-map__benefits">
        <li><UIcon name="i-lucide-timer" aria-hidden="true" />Быстрее сборка</li>
        <li><UIcon name="i-lucide-store" aria-hidden="true" />Ваш выбор продавца</li>
        <li><UIcon name="i-lucide-map-pin" aria-hidden="true" />Удобнее самовывоз</li>
      </ul>
      <UButton to="/catalog" icon="i-lucide-shopping-basket">Выбрать продукты</UButton>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import type { MarketPoint } from '~/types/market-map';
import { filterMarketPoints, marketKinds, marketKindLabels } from '~/utils/market-map';
import { breadcrumbSchema } from '~/utils/seo';
const breadcrumbs = [{ label: 'Главная', to: '/' }, { label: 'Карта рынка', to: '/market-map' }];
const route = useRoute();
const router = useRouter();
const kinds = [{ value: 'all' as const, label: 'Все точки' }, ...marketKinds.filter(item => item.value !== 'ENTRY')];
const query = computed({
  get: () => typeof route.query.q === 'string' ? route.query.q : '',
  set: value => { void router.replace({ query: { ...route.query, q: value || undefined } }); },
});
const kind = computed({
  get: () => kinds.find(item => item.value === route.query.kind)?.value ?? 'all',
  set: value => { void router.replace({ query: { ...route.query, kind: value === 'all' ? undefined : value } }); },
});
const kindFilter = computed(() => kind.value === 'all' ? '' : kind.value);
function resetFilters() {
  void router.replace({ query: { ...route.query, q: undefined, kind: undefined } });
}
const { data, error, refresh } = await useApi<MarketPoint[]>('/market-map', { query: { floor: 2 } });
const points = computed(() => data.value ?? []);
const entrances = computed(() => points.value.filter(point => point.kind === 'ENTRY'));
const visible = computed(() => filterMarketPoints(points.value, query.value, kindFilter.value));
const mapPoints = computed(() => [...visible.value, ...entrances.value]);
const focused = computed(() => points.value.find(point => point.slug === route.query.point));
usePageSeo({ title: 'Карта Багратионовского рынка · 2 этаж — KorzinaMarket',
  description: 'Лавки, магазины и фудкорт на втором этаже Багратионовского рынка. Выберите продавца заранее, уточните ассортимент по фото в чате и найдите путь для самовывоза.' });
useJsonLd(breadcrumbSchema(breadcrumbs));
</script>

<style scoped>
.market-map { min-width: 0; padding-block: var(--page-start) var(--page-end); }
.market-map__intro { display: grid; gap: .65rem; margin-bottom: 1.25rem; }
.market-map__eyebrow { color: var(--ui-primary); font-size: .875rem; font-weight: 600; }
.market-map__title { font-size: var(--page-title); line-height: 1.15; font-weight: 700; }
.market-map__lead { max-width: 70ch; line-height: 1.6; color: var(--ui-text-muted); }
.market-map__filters { display: grid; grid-template-columns: minmax(0, 1fr); gap: .75rem; margin-bottom: 1rem; }
.market-map__layout { display: grid; gap: 1rem; min-width: 0; }
.market-map__directory { min-width: 0; }
.market-map__heading { font-size: var(--section-title); font-weight: 600; }
.market-map__count { color: var(--ui-text-muted); font-size: .875rem; }
.market-map__list { display: grid; gap: .5rem; margin-top: .75rem; }
.market-map__card { display: grid; gap: .2rem; position: relative; min-height: 44px; padding: .75rem 2rem .75rem .85rem; border: 1px solid var(--ui-border); border-radius: .75rem; background: var(--ui-bg-elevated); overflow-wrap: anywhere; }
.market-map__card:hover { border-color: var(--ui-primary); }
.market-map__card:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.market-map__card-name { font-weight: 600; }
.market-map__card-type, .market-map__card-note { font-size: .75rem; color: var(--ui-text-muted); }
.market-map__card-arrow { position: absolute; top: .85rem; right: .65rem; color: var(--ui-primary); }
.market-map__empty { display: grid; justify-items: start; gap: .5rem; margin-top: 1rem; color: var(--ui-text-muted); }
.market-map__entrances { display: flex; align-items: start; gap: .5rem; margin-top: .75rem; font-size: .875rem; color: var(--ui-text-muted); }
.market-map__entrances > :first-child { flex: none; margin-top: .2rem; }
.market-map__about { display: grid; justify-items: start; gap: 1rem; margin-top: 1.5rem; padding: 1.25rem; border: 1px solid var(--ui-border); border-radius: 1rem; background: color-mix(in srgb, var(--ui-primary) 7%, var(--ui-bg-elevated)); }
.market-map__about p { max-width: 85ch; margin-top: .5rem; line-height: 1.6; color: var(--ui-text-muted); }
.market-map__benefits { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; font-size: .875rem; }
.market-map__benefits li { display: flex; align-items: center; gap: .5rem; }
.market-map__benefits :deep(svg) { color: var(--ui-primary); }
@media (min-width: 40rem) { .market-map__filters { grid-template-columns: minmax(0, 1fr) minmax(12rem, .4fr); } .market-map__list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 64rem) { .market-map__layout { grid-template-columns: minmax(0, 2fr) minmax(17rem, 1fr); } .market-map__list { display: grid; grid-template-columns: minmax(0, 1fr); max-height: 48rem; overflow-y: auto; padding: .25rem; scrollbar-gutter: stable; } }
</style>
