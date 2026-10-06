<template>
  <UContainer v-if="point" class="market-point">
    <AppBreadcrumbs :items="breadcrumbs" />
    <div class="market-point__layout">
      <div class="market-point__photo">
        <img v-if="point.photoUrl" :src="asset(point.photoUrl)" :alt="`${point.name} — точка на рынке`" class="market-point__image" fetchpriority="high">
        <div v-else class="market-point__placeholder"><UIcon name="i-lucide-store" aria-hidden="true" /><span>Фото точки появится позже</span></div>
      </div>
      <section class="market-point__info">
        <p class="market-point__meta">Багратионовский рынок · {{ point.floor }} этаж · {{ marketKindLabels[point.kind] }}</p>
        <h1 class="market-point__title">{{ point.name }}</h1>
        <UBadge v-if="point.unitNumber" color="primary" variant="subtle">Точка {{ point.unitNumber }}</UBadge>
        <p v-if="point.description" class="market-point__text">{{ point.description }}</p>
        <div v-if="point.sampleAssortment">
          <h2 class="market-point__heading">Примерный ассортимент</h2>
          <p class="market-point__text">{{ point.sampleAssortment }}</p>
        </div>
        <div class="market-point__actions">
          <UButton :to="`/market-map?point=${point.slug}`" icon="i-lucide-map-pin" variant="outline">Показать на карте</UButton>
          <UButton to="/catalog" icon="i-lucide-shopping-basket">Выбрать продукты</UButton>
        </div>
      </section>
    </div>
    <section v-if="products?.items.length" class="market-point__products" aria-labelledby="market-products">
      <h2 id="market-products" class="market-point__heading">Продукты этой точки</h2>
      <ProductGrid :items="products.items" />
    </section>
    <section v-if="point.kind !== 'ENTRY'" class="market-point__chat" aria-labelledby="market-chat">
      <div>
        <h2 id="market-chat" class="market-point__heading">Настоящий прилавок. Ваш выбор.</h2>
        <p class="market-point__text">Ассортимент может меняться в течение дня. Укажите нужную лавку в комментарии к заказу, а актуальный ассортимент и наличие уточните в чате заказа онлайн. Во время сборки продавец может показать товар по фото прямо с прилавка — так сохраняется аутентичный опыт покупки на рынке.</p>
      </div>
      <UButton to="/orders" icon="i-lucide-messages-square" variant="outline">Открыть мои заказы и чат</UButton>
    </section>
    <section v-if="point.kind !== 'ENTRY'" class="market-point__flow" aria-labelledby="market-flow">
      <h2 id="market-flow" class="market-point__heading">Как это работает</h2>
      <p class="market-point__text">Например, вы хотите гранатовый фреш в Fresh Bar.</p>
      <ol class="market-point__steps">
        <li>Выберите продукты и укажите Fresh Bar в комментарии к заказу.</li>
        <li>В чате заказа уточните, какие варианты есть сейчас.</li>
        <li>Во время сборки продавец может прислать фото актуального ассортимента.</li>
        <li>Вы согласуете нужное, а продавец соберёт заказ.</li>
      </ol>
      <NuxtLink to="/how-it-works" class="market-point__link">Подробнее о покупках с KorzinaMarket →</NuxtLink>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import type { MarketPoint } from '~/types/market-map';
import type { ProductListResponse } from '~/types/product';
import { marketKindLabels } from '~/utils/market-map';
import { breadcrumbSchema } from '~/utils/seo';
const route = useRoute();
const slug = computed(() => String(route.params.slug));
const { data: point, error } = await useApi<MarketPoint>(() => `/market-map/${encodeURIComponent(slug.value)}`);
if (error.value || !point.value) throw createError({ statusCode: error.value?.statusCode === 404 ? 404 : 503,
  statusMessage: error.value?.statusCode === 404 ? 'Точка не найдена' : 'Не удалось загрузить точку рынка' });
const asset = useAsset();
const { data: products } = await useApi<ProductListResponse>('/products', {
  query: computed(() => ({ marketPoint: slug.value, limit: 60 })),
});
const breadcrumbs = computed(() => [{ label: 'Главная', to: '/' },
  { label: 'Карта рынка', to: '/market-map' }, { label: point.value?.name ?? '', to: `/market-map/${slug.value}` }]);
usePageSeo(() => ({ title: `${point.value?.name} — Карта рынка · KorzinaMarket`,
  description: point.value?.description || 'Точка на втором этаже Багратионовского рынка. Уточните актуальный ассортимент по фото в чате заказа.',
  ...(point.value?.photoUrl ? { image: asset(point.value.photoUrl) } : {}),
}));
useJsonLd(computed(() => breadcrumbSchema(breadcrumbs.value)));
</script>

<style scoped>
.market-point { min-width: 0; padding-block: var(--page-start) var(--page-end); }
.market-point__layout { display: grid; gap: 1.25rem; }
.market-point__photo { min-width: 0; aspect-ratio: 4 / 3; max-height: 28rem; overflow: hidden; border: 1px solid var(--ui-border); border-radius: 1rem; background: var(--ui-bg-elevated); }
.market-point__image { width: 100%; height: 100%; object-fit: cover; }
.market-point__placeholder { display: grid; place-content: center; justify-items: center; gap: .75rem; height: 100%; color: var(--ui-text-muted); font-size: .875rem; }
.market-point__placeholder > :first-child { width: 3rem; height: 3rem; color: var(--ui-primary); opacity: .65; }
.market-point__info { display: grid; align-content: start; justify-items: start; gap: 1rem; min-width: 0; }
.market-point__meta { font-size: .875rem; color: var(--ui-text-muted); }
.market-point__title { font-size: var(--page-title); font-weight: 700; line-height: 1.2; overflow-wrap: anywhere; }
.market-point__heading { font-size: var(--section-title); font-weight: 600; }
.market-point__text { max-width: 80ch; line-height: 1.6; white-space: pre-line; color: var(--ui-text-muted); }
.market-point__actions { display: flex; flex-wrap: wrap; gap: .65rem; }
.market-point__chat { display: grid; justify-items: start; gap: 1rem; margin-top: 1.5rem; padding: 1.25rem; border-radius: 1rem; border: 1px solid var(--ui-border); background: color-mix(in srgb, var(--ui-primary) 7%, var(--ui-bg-elevated)); }
.market-point__chat p, .market-point__flow p { margin-top: .5rem; }
.market-point__flow { margin-top: 1.5rem; }
.market-point__products { display: grid; gap: 1rem; margin-top: 1.5rem; }
.market-point__steps { display: grid; gap: .65rem; margin: .75rem 0; padding-left: 1.5rem; list-style: decimal; color: var(--ui-text-muted); line-height: 1.5; }
.market-point__link { display: inline-flex; align-items: center; min-height: 44px; color: var(--ui-primary); }
.market-point__link:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
@media (min-width: 48rem) { .market-point__layout { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); } }
</style>
