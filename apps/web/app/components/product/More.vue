<template>
  <div class="product-more" :aria-busy="loading">
    <ProductSkeleton v-if="loading" :count="6" />
    <div ref="sentinel" class="product-more__sentinel" aria-hidden="true" />
    <div v-if="error" class="product-more__error" role="alert">
      <p>{{ stale ? 'Каталог обновился. Обновите витрину, чтобы продолжить.' : 'Не удалось загрузить товары. Попробуйте ещё раз.' }}</p>
      <UButton type="button" variant="soft" @click="emit('retry')">{{ stale ? 'Обновить витрину' : 'Повторить' }}</UButton>
    </div>
    <div v-else-if="hasMore" class="product-more__action">
      <UButton type="button" variant="soft" :loading="loading" @click="emit('load')">Показать ещё</UButton>
    </div>
    <p v-else class="product-more__end" role="status">Вы посмотрели все товары</p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ hasMore: boolean; loading: boolean; error?: boolean; stale?: boolean }>();
const emit = defineEmits<{ load: []; retry: [] }>();
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | undefined;
let visible = false;
function loadVisible() {
  if (visible && props.hasMore && !props.loading && !props.error) emit('load');
}
onMounted(() => {
  if (!sentinel.value || typeof IntersectionObserver === 'undefined') return;
  observer = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    loadVisible();
  }, { rootMargin: '400px 0px' });
  observer.observe(sentinel.value);
});
watch(() => [props.hasMore, props.loading, props.error], loadVisible, { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.product-more { min-width: 0; margin-top: 1rem; }
.product-more__sentinel { height: 1px; }
.product-more__action { display: flex; justify-content: center; padding-top: 1rem; }
.product-more__error { display: grid; justify-items: start; gap: 0.75rem; color: var(--ui-text-muted); }
.product-more__end { padding-block: 1.5rem; text-align: center; color: var(--ui-text-muted); font-size: 0.875rem; }
</style>
