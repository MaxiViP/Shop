<template>
  <UContainer class="delivery">
    <AppBreadcrumbs :items="breadcrumbs" />
    <h1 class="delivery__title">Доставка продуктов с рынка по Москве</h1>
    <p class="delivery__text">{{ site.about }}</p>
    <h2 class="delivery__subtitle">Где доставка особенно быстрая?</h2>
    <p class="delivery__text">{{ site.delivery.priorityText }}</p>
    <h2 class="delivery__subtitle">Как рассчитывается стоимость?</h2>
    <p class="delivery__text">{{ site.delivery.pricingText }}</p>
    <p class="delivery__text">Основной способ доставки — {{ site.delivery.providerLabel }}. Стоимость уточняется по адресу и актуальному расчёту сервиса.</p>
    <h2 class="delivery__subtitle">Как заказать продукты домой?</h2>
    <p class="delivery__text">Выберите товары в каталоге, откройте корзину, укажите данные получателя и адрес доставки, затем оформите заказ.</p>
    <UButton class="delivery__action" to="/catalog">Перейти в каталог</UButton>
  </UContainer>
</template>

<script setup lang="ts">
import { site } from "~~/shared/utils/site";
import { breadcrumbSchema } from "~/utils/seo";
const breadcrumbs = [{ label: "Главная", to: "/" }, { label: "Доставка", to: "/delivery" }];
usePageSeo({
  title: "Доставка продуктов с рынка по Москве — KorzinaMarket",
  description: "Доставка продуктов по Москве: приоритетные районы, расчёт стоимости по адресу и расстоянию, оформление заказа в KorzinaMarket.",
});
useJsonLd(breadcrumbSchema(breadcrumbs));
</script>

<style scoped>
.delivery { min-width: 0; padding-block: var(--page-start) var(--page-end); }
.delivery__title { font-size: var(--page-title); font-weight: 700; line-height: 1.1; overflow-wrap: anywhere; }
.delivery__subtitle { margin-top: 1.5rem; font-size: var(--section-title); font-weight: 600; }
.delivery__text { max-width: 70ch; margin-top: 1rem; line-height: 1.65; color: var(--ui-text-muted); }
.delivery__action { margin-top: 1.5rem; min-height: 44px; }
</style>
