<template>
  <UContainer class="market">
    <AppBreadcrumbs :items="breadcrumbs" />
    <section class="market__intro">
      <p class="market__eyebrow">Ваш человек на рынке.</p>
      <h1 class="market__title">Аутентичный рынок — где бы вы ни находились.</h1>
      <p class="market__lead">KorzinaMarket — это не обычная доставка продуктов. Вы выбираете товары так, будто сами пришли на рынок, только не тратите время на дорогу и очереди.</p>
      <UButton to="/catalog" size="lg">Выбрать продукты</UButton>
    </section>
    <section class="market__section" aria-labelledby="market-choice">
      <h2 id="market-choice" class="market__heading">Выбирайте глазами, как на настоящем рынке.</h2>
      <p class="market__text">Настоящий прилавок. Настоящий продавец. Ваш выбор.</p>
      <ol class="market__flow">
        <li v-for="(step, index) in steps" :key="step.title" class="market__step">
          <span class="market__number" aria-hidden="true">{{ index + 1 }}</span>
          <div>
            <h3 class="market__step-title">{{ step.title }}</h3>
            <p class="market__text">{{ step.text }}</p>
          </div>
          <UIcon :name="step.icon" class="market__icon" aria-hidden="true" />
        </li>
      </ol>
    </section>
    <section id="delivery" class="market__section" aria-labelledby="market-delivery">
      <h2 id="market-delivery" class="market__heading">Как получить выбранные продукты</h2>
      <div class="market__options">
        <UCard>
          <template #header><h3 class="font-semibold">Доставка по Москве</h3></template>
          <p class="market__text">{{ site.delivery.priorityText }}</p>
          <p class="market__text">{{ site.delivery.pricingText }}</p>
          <p class="market__text">Основной способ доставки — {{ site.delivery.providerLabel }}. Стоимость уточняется по адресу и актуальному расчёту сервиса. Доставка оплачивается отдельно от продуктов.</p>
          <p class="market__text">Для доставки выберите товары, укажите данные получателя и адрес в корзине, затем оформите заказ.</p>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Самовывоз с рынка</h3></template>
          <p class="market__text">Выберите самовывоз при оформлении. Продавец соберёт и согласует заказ, а вы заберёте готовые продукты в точке выдачи.</p>
          <OrderPickupPoint />
          <UButton to="/market-map" icon="i-lucide-map" variant="link">Посмотреть карту рынка</UButton>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Сборка и очередь</h3></template>
          <p class="market__text">Сборка идёт по рабочей очереди рынка. В заказе видно примерное ожидание и текущий этап. При высокой нагрузке ожидание может увеличиваться — ориентир обновляется по состоянию очереди.</p>
          <p class="market__text">Фото прилавка можно получить во время сборки. Вес, количество, замены и изменившуюся рыночную цену обсуждайте с продавцом в чате; точная сумма появится после завершения сборки.</p>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Заказ ко времени</h3></template>
          <p class="market__text">Когда эта возможность предлагается, выберите доступное время при оформлении или в своём заказе до начала сборки. Это время готовности продуктов, а доставка занимает дополнительное время.</p>
          <p class="market__text">Доступные варианты учитывают график рынка и уже принятые заказы. Если подходящее время занято, выберите другое или дождитесь сборки в очереди.</p>
        </UCard>
      </div>
    </section>
    <div class="market__finish">
      <p class="market__heading">Рынок стал ближе — даже если вы остались дома.</p>
      <UButton to="/catalog" size="lg">Собрать корзину</UButton>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { site } from '~~/shared/utils/site';
import { breadcrumbSchema } from '~/utils/seo';
const breadcrumbs = [{ label: 'Главная', to: '/' }, { label: 'Как это работает', to: '/how-it-works' }];
const steps = [
  { title: 'Выберите продукты', text: 'Добавьте нужное в корзину и оформите заказ с доставкой или самовывозом.', icon: 'i-lucide-shopping-basket' },
  { title: 'Ваш продавец начинает сборку', text: 'Заказ собирает реальный человек на настоящем московском рынке.', icon: 'i-lucide-store' },
  { title: 'Посмотрите на актуальный прилавок', text: 'Во время сборки продавец может прислать фото доступных продуктов прямо с рынка.', icon: 'i-lucide-camera' },
  { title: 'Отметьте именно тот продукт', text: 'Откройте настоящий снимок и отметьте понравившийся товар прямо на фотографии. Продавец увидит ваш выбор на том же фото.', icon: 'i-lucide-pencil' },
  { title: 'Общайтесь напрямую', text: 'Прямой чат связывает вас с продавцом: задавайте вопросы и обсуждайте детали покупки.', icon: 'i-lucide-messages-square' },
  { title: 'Согласуйте детали сборки', text: 'Уточните количество, вес и замены. Если фактическая рыночная цена изменилась, продавец согласует её с вами.', icon: 'i-lucide-scale' },
  { title: 'Получите согласованные продукты', text: 'В заказ попадут именно те продукты, которые вы выбрали и согласовали с продавцом.', icon: 'i-lucide-package-check' },
];
usePageSeo({ title: 'Как это работает — KorzinaMarket',
  description: 'Аутентичный поход на рынок из дома: реальный продавец, фото прилавка, выбор конкретного продукта и прямой чат. Доставка и самовывоз по Москве.' });
useJsonLd(breadcrumbSchema(breadcrumbs));
</script>

<style scoped>
.market { min-width: 0; padding-block: var(--page-start) var(--page-end); }
.market__intro { display: grid; gap: 1.25rem; justify-items: start; padding: clamp(1rem, 4vw, 3rem); border-radius: 1.25rem; background: linear-gradient(135deg, color-mix(in srgb, var(--ui-primary) 14%, var(--ui-bg)), var(--ui-bg-elevated)); }
.market__eyebrow { color: var(--ui-primary); font-weight: 600; }
.market__title { max-width: 22ch; font-size: var(--page-title); font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
.market__lead { max-width: 65ch; font-size: 1.125rem; line-height: 1.65; color: var(--ui-text-muted); }
.market__section { margin-top: var(--section-gap); scroll-margin-top: var(--header-height); }
.market__heading { font-size: var(--section-title); font-weight: 700; line-height: 1.25; }
.market__text { margin-top: 0.65rem; max-width: 70ch; line-height: 1.6; color: var(--ui-text-muted); }
.market__flow { display: grid; gap: 0.75rem; margin-top: 1.5rem; padding: 0; list-style: none; }
.market__step { display: flex; align-items: start; gap: 0.9rem; min-width: 0; padding: 1rem; border: 1px solid var(--ui-border); border-radius: 1rem; background: var(--ui-bg-elevated); }
.market__number { display: grid; place-items: center; flex: none; width: 2rem; height: 2rem; border-radius: 50%; color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 14%, var(--ui-bg)); font-weight: 700; }
.market__step-title { font-weight: 600; }
.market__icon { flex: none; margin-left: auto; color: var(--ui-primary); font-size: 1.3rem; }
.market__options { display: grid; gap: 1rem; margin-top: 1.5rem; grid-template-columns: minmax(0, 1fr); }
.market__finish { display: grid; justify-items: start; gap: 1.25rem; margin-top: var(--section-gap); }
@media (min-width: 48rem) { .market__options { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
