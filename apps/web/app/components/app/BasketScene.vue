<template>
  <svg
    class="basket-scene"
    :class="'basket-scene--' + state"
    viewBox="0 0 100 100"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <clipPath :id="id + '-front'">
        <path d="M 30 46 C 40 42 49 47 56 46 C 64 41 74 45 81 49 L 82 62 L 35 65 L 28 59 Z" />
      </clipPath>
      <clipPath :id="id + '-grapes'">
        <path d="M 10 41 C 16 35 24 38 31 39 C 38 38 44 47 47 56 L 40 62 L 18 61 L 10 54 Z" />
      </clipPath>
      <clipPath :id="id + '-bananas'">
        <path d="M 32 24 C 33 18 40 19 47 23 L 55 32 L 61 38 L 57 51 L 36 53 L 30 43 Z" />
      </clipPath>
      <clipPath :id="id + '-vegetables'">
        <path d="M 43 31 C 50 27 65 28 71 36 C 75 28 83 28 87 32 L 99 35 L 99 56 L 88 64 L 72 64 L 65 56 L 49 59 L 39 48 Z" />
      </clipPath>
      <clipPath :id="id + '-greens'">
        <path d="M 6 35 C 10 25 15 25 21 28 C 25 18 35 16 43 22 C 48 14 59 14 66 20 C 71 14 86 17 96 26 L 100 42 L 92 53 L 72 45 L 55 37 L 35 40 L 17 53 L 7 52 Z" />
      </clipPath>
    </defs>
    <image class="basket-scene__empty" href="/img/logo/empty-cutout.webp" x="0" y="-3" width="100" height="100" />
    <g class="basket-scene__drop basket-scene__drop--front" :clip-path="'url(#' + id + '-front)'">
      <image href="/img/logo/full-cutout.webp" x="0" y="-3" width="100" height="100" />
    </g>
    <g class="basket-scene__drop basket-scene__drop--grapes" :clip-path="'url(#' + id + '-grapes)'">
      <image href="/img/logo/full-cutout.webp" x="0" y="-3" width="100" height="100" />
    </g>
    <g class="basket-scene__drop basket-scene__drop--bananas" :clip-path="'url(#' + id + '-bananas)'">
      <image href="/img/logo/full-cutout.webp" x="0" y="-3" width="100" height="100" />
    </g>
    <g class="basket-scene__drop basket-scene__drop--vegetables" :clip-path="'url(#' + id + '-vegetables)'">
      <image href="/img/logo/full-cutout.webp" x="0" y="-3" width="100" height="100" />
    </g>
    <g class="basket-scene__drop basket-scene__drop--greens" :clip-path="'url(#' + id + '-greens)'">
      <image href="/img/logo/full-cutout.webp" x="0" y="-3" width="100" height="100" />
    </g>
    <image class="basket-scene__full" href="/img/logo/full-cutout.webp" x="0" y="-3" width="100" height="100" />
  </svg>
</template>

<script setup lang="ts">
import { useId } from "vue";

defineProps<{ state: "empty" | "full" | "animate" }>();
const id = useId();
</script>

<style scoped>
.basket-scene {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.basket-scene__drop,
.basket-scene__full {
  opacity: 0;
}

.basket-scene--full .basket-scene__empty {
  opacity: 0;
}

.basket-scene--full .basket-scene__full {
  opacity: 1;
}

.basket-scene--animate .basket-scene__empty {
  animation: basket-scene-hide 0.55s 4.2s ease-in forwards;
}

.basket-scene--animate .basket-scene__drop {
  transform-box: view-box;
  transform-origin: 50% 45%;
  animation: basket-scene-drop 0.72s cubic-bezier(0.23, 1.2, 0.4, 1) both;
}

.basket-scene--animate .basket-scene__drop--front { animation-delay: 0.2s; }
.basket-scene--animate .basket-scene__drop--grapes { animation-delay: 0.95s; }
.basket-scene--animate .basket-scene__drop--bananas { animation-delay: 1.7s; }
.basket-scene--animate .basket-scene__drop--vegetables { animation-delay: 2.5s; }
.basket-scene--animate .basket-scene__drop--greens { animation-delay: 3.35s; }

.basket-scene--animate .basket-scene__full {
  animation: basket-scene-show 0.55s 4.2s ease-out forwards;
}

@keyframes basket-scene-drop {
  from { opacity: 0; transform: translateY(-11px) scale(0.97); }
  65% { opacity: 1; transform: translateY(1.8px) scale(1); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes basket-scene-hide {
  to { opacity: 0; }
}

@keyframes basket-scene-show {
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .basket-scene--animate .basket-scene__empty,
  .basket-scene--animate .basket-scene__drop,
  .basket-scene--animate .basket-scene__full {
    animation: none;
  }

  .basket-scene--animate .basket-scene__empty,
  .basket-scene--animate .basket-scene__drop {
    opacity: 0;
  }

  .basket-scene--animate .basket-scene__full {
    opacity: 1;
  }
}
</style>
