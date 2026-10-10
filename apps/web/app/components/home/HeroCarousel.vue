<template>
  <section
    v-if="activeSlide"
    class="hero"
    :class="{ 'hero--feature': featureSlide }"
    aria-label="Прилавки рынка"
    @pointerdown="startSwipe"
    @pointerup="endSwipe"
    @pointercancel="cancelSwipe"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focusin="focused = true"
    @focusout="leaveFocus"
  >
    <div class="hero__slide">
      <Transition
        mode="out-in"
        enter-active-class="hero__frame--changing"
        leave-active-class="hero__frame--changing"
        enter-from-class="hero__frame--hidden"
        leave-to-class="hero__frame--hidden"
      >
        <div :key="activeSlide.id" class="hero__frame">
          <img
            v-if="activeSlide.image"
            class="hero__image"
            :src="asset(activeSlide.image)"
            :style="{ objectPosition: activeSlide.position ?? 'center' }"
            alt=""
            draggable="false"
          >

          <div class="hero__content hero__content--active" :data-slide-id="activeSlide.id" :aria-hidden="featureSlide || undefined">
            <p v-if="activeSlide.eyebrow" class="hero__label">
              {{ activeSlide.eyebrow }}
            </p>

            <h1 class="hero__title">
              {{ activeSlide.title }}
            </h1>

            <p class="hero__text">
              {{ activeSlide.text }}
            </p>

            <UButton v-if="activeSlide.buttonLabel && activeSlide.to" class="hero__action" :to="activeSlide.to" size="lg">
              {{ activeSlide.buttonLabel }}
            </UButton>
          </div>
        </div>
      </Transition>

      <div class="hero__reserve" aria-hidden="true" inert>
        <div v-for="slide in heroSlides" :key="slide.id" class="hero__content hero__content--reserve">
          <p v-if="slide.eyebrow" class="hero__label">{{ slide.eyebrow }}</p>
          <p class="hero__title">{{ slide.title }}</p>
          <p class="hero__text">{{ slide.text }}</p>
          <UButton v-if="slide.buttonLabel && slide.to" class="hero__action" size="lg" tabindex="-1">{{ slide.buttonLabel }}</UButton>
        </div>
      </div>

      <section
        class="home__feature"
        aria-labelledby="market-photo-choice"
        :aria-hidden="(compact && !featureSlide) || undefined"
      >
        <div class="home__feature-head">
          <span class="home__feature-icon" aria-hidden="true"
            ><UIcon name="i-lucide-store"
          /></span>
          <div>
            <h2 id="market-photo-choice" class="home__feature-title">
              Выбирайте продукты прямо с прилавка
            </h2>
            <p class="home__feature-text">
              Не уверены, какой товар взять? Продавец отправит актуальное фото
              прилавка прямо из рынка. Откройте снимок, отметьте понравившийся
              продукт и отправьте отметку продавцу — он увидит, что именно вы
              выбрали.
            </p>
          </div>
        </div>
        <ol
          class="home__feature-flow"
          aria-label="Как выбрать продукт с прилавка"
        >
          <li>
            <UIcon
              name="i-lucide-camera"
              class="home__feature-step-icon"
              aria-hidden="true"
            /><span>Продавец фотографирует</span
            ><UIcon
              name="i-lucide-arrow-right"
              class="home__feature-arrow"
              aria-hidden="true"
            />
          </li>
          <li>
            <UIcon
              name="i-lucide-pencil"
              class="home__feature-step-icon"
              aria-hidden="true"
            /><span>Вы отмечаете</span
            ><UIcon
              name="i-lucide-arrow-right"
              class="home__feature-arrow"
              aria-hidden="true"
            />
          </li>
          <li>
            <UIcon
              name="i-lucide-shopping-basket"
              class="home__feature-step-icon"
              aria-hidden="true"
            /><span>Продавец кладёт выбранный товар в заказ</span>
          </li>
        </ol>
      </section>
    </div>
    <div v-if="slideCount > 1" class="hero__controls" role="group" aria-label="Переключение слайдов">
      <UButton
        class="hero__arrow" type="button" :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
        color="neutral" variant="ghost" :aria-label="paused ? 'Включить автоматическое переключение' : 'Остановить автоматическое переключение'"
        :aria-pressed="paused" @click="paused = !paused" />
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
        <span class="sr-only">Слайд </span>{{ activeIndex + 1 }} /
        {{ slideCount }}
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
import { heroDuration } from '~/utils/home-slides';
const { slides: heroSlides } = await useHomeSlides();
const asset = useAsset();
const activeIndex = ref(0);
const compact = ref(false);
const hovered = ref(false);
const focused = ref(false);
const paused = ref(false);
const reducedMotion = ref(false);
const hidden = ref(false);
const slideCount = computed(() => heroSlides.value.length + (compact.value && heroSlides.value.length ? 1 : 0));
const featureSlide = computed(
  () => compact.value && activeIndex.value === heroSlides.value.length,
);
const activeSlide = computed(
  () => heroSlides.value[activeIndex.value] ?? heroSlides.value[0],
);
let media: MediaQueryList | undefined;
let motion: MediaQueryList | undefined;
let autoplay: ReturnType<typeof setTimeout> | undefined;
let swipe: { id: number; x: number; y: number } | null = null;

function updateLayout() {
  compact.value = media?.matches ?? false;
  if (activeIndex.value >= slideCount.value) activeIndex.value = 0;
}
function updateMotion() { reducedMotion.value = motion?.matches ?? false; }
function updateVisibility() { hidden.value = document.hidden; }
function restartAutoplay() {
  clearTimeout(autoplay);
  if (slideCount.value > 1 && !hovered.value && !focused.value && !paused.value && !reducedMotion.value && !hidden.value) {
    autoplay = setTimeout(() => changeSlide(1), heroDuration(activeSlide.value, featureSlide.value));
  }
}
function leaveFocus(event: FocusEvent) {
  focused.value = event.currentTarget instanceof HTMLElement && event.relatedTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget);
}
watch([slideCount, hovered, focused, paused, reducedMotion, hidden], restartAutoplay);
watch(activeSlide, restartAutoplay);
watch(() => heroSlides.value.map(slide => slide.id).join(','), () => { activeIndex.value = 0; restartAutoplay(); });
onMounted(() => {
  media = window.matchMedia("(max-width: 63.999rem)");
  updateLayout();
  media.addEventListener("change", updateLayout);
  motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  updateMotion(); updateVisibility(); restartAutoplay();
  motion.addEventListener('change', updateMotion);
  document.addEventListener('visibilitychange', updateVisibility);
});
onBeforeUnmount(() => {
  media?.removeEventListener('change', updateLayout);
  motion?.removeEventListener('change', updateMotion);
  document.removeEventListener('visibilitychange', updateVisibility);
  clearTimeout(autoplay);
});

function changeSlide(direction: number) {
  if (!slideCount.value) return;
  activeIndex.value =
    (activeIndex.value + direction + slideCount.value) % slideCount.value;
  restartAutoplay();
}

function startSwipe(event: PointerEvent) {
  swipe = null;
  if (event.pointerType !== "touch" || !event.isPrimary) return;
  if (event.target instanceof Element && event.target.closest("a, button"))
    return;
  swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
  clearTimeout(autoplay);
}

function endSwipe(event: PointerEvent) {
  const start = swipe;
  swipe = null;
  restartAutoplay();
  if (!start || start.id !== event.pointerId) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) {
    changeSlide(dx < 0 ? 1 : -1);
  }
}
function cancelSwipe() { swipe = null; restartAutoplay(); }
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
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: clamp(1.25rem, 3vw, 2.5rem);
  min-width: 0;
  min-height: inherit;
  align-items: center;
  padding: clamp(1rem, 4vw, 4rem);
  padding-bottom: 4.75rem;
}

.hero__frame {
  isolation: isolate;
  grid-area: 1 / 1;
  display: grid;
  align-items: center;
  min-width: 0;
}

.hero__image {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero__frame::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(
    90deg,
    rgba(5, 15, 30, 0.72) 0%,
    rgba(5, 15, 30, 0.52) 55%,
    rgba(5, 15, 30, 0.18) 100%
  );
  pointer-events: none;
}

.hero__content {
  grid-area: 1 / 1;
  position: relative;
  z-index: 2;
  width: 100%;
  min-width: 0;
  max-width: 54rem;
}

.hero__reserve { grid-area: 1 / 1; display: grid; min-width: 0; visibility: hidden; pointer-events: none; }
.hero__content--reserve { visibility: hidden; }

.hero__frame--changing { transition: opacity 180ms ease; }
.hero__frame--hidden { opacity: 0; }

.hero__label {
  overflow-wrap: anywhere;
  color: var(--ui-primary);
  font-weight: 600;
}

.hero__title {
  max-width: 54rem;
  color: #fff;
  text-shadow: 0 2px 10px rgb(0 0 0 / 45%);
  overflow-wrap: anywhere;
  margin-top: 0.75rem;
  font-size: clamp(1.75rem, 1.15rem + 2.8vw, 3.5rem);
  font-weight: 700;
  line-height: 1.12;
  white-space: pre-line;
}

.hero__text {
  overflow-wrap: anywhere;
  max-width: 35rem;
  margin-block: 1rem 1.5rem;
  color: rgba(255, 255, 255, 0.96);
  text-shadow: 0 1px 6px rgb(0 0 0 / 45%);
  font-size: clamp(1.0625rem, 0.95rem + 0.5vw, 1.25rem);
  line-height: 1.6;
}

.hero__action {
  width: 100%;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  min-height: var(--touch-target);
  justify-content: center;
}

.home__feature {
  grid-area: 1 / 1;
  visibility: hidden;
  position: relative;
  z-index: 2;
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  padding: clamp(0.875rem, 2vw, 1.25rem);
  border: 1px solid rgb(255 255 255 / 25%);
  border-radius: 1rem;
  background: rgb(5 15 30 / 82%);
  color: #fff;
}
.home__feature-head {
  display: flex;
  align-items: start;
  gap: 0.75rem;
  min-width: 0;
}
.home__feature-head > div {
  min-width: 0;
}
.home__feature-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 2rem;
  height: 2rem;
  border-radius: 0.5rem;
  color: var(--ui-primary);
  background: rgb(255 255 255 / 10%);
  font-size: 1.125rem;
}
.home__feature-title {
  font-size: clamp(1.0625rem, 1.5vw, 1.25rem);
  font-weight: 700;
  line-height: 1.25;
}
.home__feature-text {
  margin-top: 0.5rem;
  color: rgb(255 255 255 / 90%);
  font-size: 0.875rem;
  line-height: 1.5;
}
.home__feature-flow {
  display: grid;
  gap: 0.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.home__feature-flow li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.5rem 0.625rem;
  border: 1px solid rgb(255 255 255 / 20%);
  border-radius: 0.625rem;
  background: rgb(255 255 255 / 5%);
  font-size: 0.8125rem;
  line-height: 1.4;
}
.home__feature-step-icon {
  flex: none;
  color: var(--ui-primary);
  font-size: 1.1rem;
}
.home__feature-arrow {
  flex: none;
  margin-left: auto;
  color: var(--ui-primary);
}

.hero--feature .hero__content {
  visibility: hidden;
}
.hero--feature .home__feature {
  visibility: visible;
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
  .hero__slide, .hero__frame--changing {
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
  .home__feature-flow {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (min-width: 64rem) {
  .hero__slide {
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  }
  .home__feature {
    grid-area: 1 / 2;
    visibility: visible;
  }
  .home__feature-flow {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
