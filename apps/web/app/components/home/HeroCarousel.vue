<template>
  <section
    class="hero"
    aria-label="Прилавки рынка"
    @pointerdown="startSwipe"
    @pointerup="endSwipe"
    @pointercancel="swipe = null"
  >
   <div class="hero__slide">
  <img
    class="hero__image"
    :src="activeSlide.image"
    :style="{ objectPosition: activeSlide.position ?? 'center' }"
    alt=""
    draggable="false"
  >

  <div class="hero__content">
    <p class="hero__label">
      {{ activeSlide.eyebrow }}
    </p>

    <h1 class="hero__title">
      {{ activeSlide.title }}
    </h1>

    <p class="hero__text">
      {{ activeSlide.text }}
    </p>

    <UButton
      class="hero__action"
      :to="activeSlide.to"
      size="lg"
    >
      {{ activeSlide.buttonLabel }}
    </UButton>
  </div>
</div>
    <div class="hero__controls" role="group" aria-label="Переключение слайдов">
      <UButton
        class="hero__arrow"
        type="button"
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="ghost"
        aria-label="Предыдущий слайд"
        @click="changeSlide(-1)"
      />
      <span class="hero__counter" aria-live="polite" aria-atomic="true">
        <span class="sr-only">Слайд </span>{{ activeIndex + 1 }} / {{ heroSlides.length }}
      </span>
      <UButton
        class="hero__arrow"
        type="button"
        icon="i-lucide-chevron-right"
        color="neutral"
        variant="ghost"
        aria-label="Следующий слайд"
        @click="changeSlide(1)"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
type HeroSlide = {
  image: string;
  position?: string;
  eyebrow: string;
  title: string;
  text: string;
  buttonLabel: string;
  to: string;
};

const heroSlides: HeroSlide[] = [
  {
    image: "/images/hero/hero-0.webp",
    position: "center",
    eyebrow: "Москва",
    title: "Свежие продукты и товары с рынка",
    text: "Овощи, Фрукты, Ягоды, Зелень и многое другое с доставкой на дом.",
    buttonLabel: "В каталог",
    to: "/catalog",
  },
  {
    image: "/images/hero/hero-1.webp",
    position: "center",
    eyebrow: "Прилавки рынка",
    title: "Продукты для вашего стола",
    text: "Выбирайте продукты и товары в каталоге рынка.",
    buttonLabel: "Смотреть каталог",
    to: "/catalog",
  },
  {
    image: "/images/hero/hero-2.webp",
    position: "center",
    eyebrow: "Покупки на рынке",
    title: "Соберите свою корзину",
    text: "Всё для домашнего меню — в одном каталоге.",
    buttonLabel: "Выбрать продукты",
    to: "/catalog",
  },
  {
    image: "/images/hero/hero-3.webp",
    position: "center",
    eyebrow: "Рынок рядом",
    title: "Покупки с доставкой на дом",
    text: "Добавляйте любимые продукты в корзину и оформляйте доставку.",
    buttonLabel: "Перейти в каталог",
    to: "/catalog",
  },
];
const activeIndex = ref(0);
const activeSlide = computed(() => heroSlides[activeIndex.value]!);
let swipe: { id: number; x: number; y: number } | null = null;

function changeSlide(direction: number) {
  activeIndex.value = (activeIndex.value + direction + heroSlides.length) % heroSlides.length;
}

function startSwipe(event: PointerEvent) {
  swipe = null;
  if (event.pointerType !== "touch" || !event.isPrimary) return;
  if (event.target instanceof Element && event.target.closest("a, button")) return;
  swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
}

function endSwipe(event: PointerEvent) {
  const start = swipe;
  swipe = null;
  if (!start || start.id !== event.pointerId) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) {
    changeSlide(dx < 0 ? 1 : -1);
  }
}

</script>

<style scoped>
.hero {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  min-width: 0;
  min-height: clamp(24rem, 80vw, 30rem);
  margin-top: var(--page-start);
  touch-action: pan-y pinch-zoom;
  overflow: hidden;
  border-radius: 1rem;
  background-color: #050f1e;
}

/* Shared grid area reserves the height of the longest slide at every width. */
.hero__slide {
  position: relative;
  isolation: isolate;
  grid-area: 1 / 1;
  display: flex;
  min-width: 0;
  min-height: inherit;
  align-items: center;
  padding: clamp(1rem, 4vw, 4rem);
  padding-bottom: 4.75rem;
}

.hero__image {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero__slide::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(90deg, rgba(5, 15, 30, 0.50) 0%, rgba(5, 15, 30, 0.35) 55%, rgba(5, 15, 30, 0.18) 100%);
  pointer-events: none;
}

.hero__content {
  position: relative;
  z-index: 2;
  width: 100%;
  min-width: 0;
  max-width: 40rem;
}

.hero__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.hero__title {
  max-width: 40rem;
  color: #fff;
  text-shadow: 0 2px 10px rgb(0 0 0 / 45%);
  overflow-wrap: anywhere;
  margin-top: 0.75rem;
  font-size: clamp(2rem, 1.25rem + 3.5vw, 4.5rem);
  font-weight: 700;
  line-height: 1.12;
}

.hero__text {
  max-width: 35rem;
  margin-block: 1rem 1.5rem;
  color: rgba(255, 255, 255, 0.96);
  text-shadow: 0 1px 6px rgb(0 0 0 / 45%);
  font-size: clamp(1.0625rem, 0.95rem + 0.5vw, 1.25rem);
  line-height: 1.6;
}

.hero__action {
  width: 100%;
  min-height: var(--touch-target);
  justify-content: center;
}

.hero__controls {
  position: absolute;
  right: clamp(1rem, 4vw, 4rem);
  bottom: 1rem;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding-inline: 0.125rem;
  border: 1px solid rgb(255 255 255 / 30%);
  border-radius: 999px;
  background: rgb(5 15 30 / 65%);
  color: #fff;
}

.hero__arrow {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  border-radius: 999px;
  color: inherit;
}

.hero__arrow:hover {
  background: rgb(255 255 255 / 15%);
}

.hero__arrow:focus-visible {
  outline: 2px solid #fff;
  outline-offset: -3px;
}

.hero__counter {
  min-width: 2.5rem;
  text-align: center;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .hero__slide {
    transition: none;
  }
}

@media (min-width: 40rem) {
  .hero__action {
    width: auto;
  }
}
@media (min-width: 48rem) {
  .hero {
    min-height: clamp(22rem, 42vw, 36rem);
  }
}
</style>
