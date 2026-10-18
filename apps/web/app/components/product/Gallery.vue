<template>
  <div class="gallery" :class="{ 'gallery--multiple': hasThumbnails }">
    <div class="gallery__viewport">
      <ProductImage
        :image="current"
        :alt="current?.alt || name"
        context="original"
        :identity="name + ':' + selected"
        class="gallery__image"
        decoding="async"
      >
        <span class="gallery__empty">Фото скоро</span>
      </ProductImage>
    </div>
    <p v-if="productIllustration(current)" class="gallery__illustration">Иллюстрация товара</p>
    <div
      v-if="hasThumbnails"
      class="gallery__rail"
      aria-label="Фотографии товара"
    >
      <button
        v-for="(image, index) in images"
        :key="image.url"
        type="button"
        class="gallery__thumb"
        :class="{ 'gallery__thumb--active': selected === index }"
        :aria-label="`Показать фото ${index + 1}`"
        :aria-current="selected === index ? 'true' : undefined"
        @click="select(index)"
      >
        <ProductImage
          :image="image"
          :alt="image.alt || name"
          context="thumbnail"
          :identity="name"
          loading="lazy"
          decoding="async"
        ><span class="gallery__empty" aria-hidden="true">Фото</span></ProductImage>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ProductImage } from '~/types/product';
import { productIllustration } from '~/utils/product-illustration';
const props = defineProps<{
  images: ProductImage[];
  name: string;
}>();
const { selected, current, hasThumbnails, select } = useProductGallery(
  () => props.images,
);
</script>

<style scoped>
.gallery {
  display: grid;
  min-width: 0;
  gap: 0.75rem;
  align-self: start;
}
.gallery__viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  display: grid;
  place-items: center;
  border-radius: 1.25rem;
  background: var(--ui-bg-muted);
}
.gallery__image {
  position: absolute;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.gallery__empty {
  color: var(--ui-text-muted);
}
.gallery__illustration { color: var(--ui-text-muted); font-size: 0.8125rem; }
.gallery__rail {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  padding: 0.25rem;
  scrollbar-width: thin;
  scroll-snap-type: x proximity;
}
.gallery__thumb {
  flex: 0 0 4rem;
  width: 4rem;
  height: 4rem;
  min-width: 44px;
  min-height: 44px;
  padding: 0.2rem;
  border: 2px solid transparent;
  border-radius: 0.75rem;
  background: var(--ui-bg-muted);
  cursor: pointer;
  scroll-snap-align: start;
}
.gallery__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 0.4rem;
}
.gallery__thumb--active {
  border-color: var(--ui-primary);
  background: var(--ui-bg);
}
.gallery__thumb:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
@media (min-width: 48rem) {
  .gallery--multiple {
    position: relative;
    padding-right: 5.25rem;
  }
  .gallery__rail {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 4.5rem;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-snap-type: y proximity;
  }
}
</style>
