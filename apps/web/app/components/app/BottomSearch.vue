<template>
  <form
    class="bottom-search"
    role="search"
    aria-label="Поиск товаров"
    @submit.prevent="submitSearch"
  >
    <UIcon name="i-lucide-search" class="bottom-search__icon" />
    <input
      v-model="search"
      class="bottom-search__input"
      type="search"
      enterkeyhint="search"
      aria-label="Поиск товаров"
      placeholder="Поиск товаров"
      maxlength="100"
    >
    <UButton
      v-if="search"
      class="bottom-search__button"
      icon="i-lucide-x"
      variant="ghost"
      color="neutral"
      aria-label="Очистить поиск"
      @click="clearSearch"
    />
    <UButton
      class="bottom-search__button"
      type="submit"
      icon="i-lucide-arrow-right"
      variant="ghost"
      aria-label="Найти товары"
    />
  </form>
</template>

<script setup lang="ts">
const { search, submitSearch, clearSearch } = useProductSearch();
</script>

<style scoped>
.bottom-search {
  position: fixed;
  left: 50%;
  bottom: calc(0.75rem + var(--safe-bottom));
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: calc(100% - 1.5rem - var(--safe-left) - var(--safe-right));
  max-width: 26.25rem;
  min-height: 3.5rem;
  padding: 0.25rem 0.4rem 0.25rem 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 2rem;
  background: var(--ui-bg);
  box-shadow: 0 4px 24px #0002;
  z-index: 20;
}
.bottom-search__input {
  flex: 1;
  min-width: 0;
  padding: 0.5rem 0.25rem;
  font-size: 1rem;
  background: transparent;
  outline: none;
}
.bottom-search:focus-within {
  outline: 2px solid var(--ui-primary);
}
.bottom-search__input::placeholder {
  color: var(--ui-text-muted);
  opacity: 1;
}
.bottom-search__input::-webkit-search-cancel-button {
  display: none;
}
.bottom-search__icon {
  flex-shrink: 0;
  color: var(--ui-text-muted);
}
.bottom-search__button {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  border-radius: 50%;
}
@media (min-width: 48rem) {
  .bottom-search {
    display: none;
  }
}
</style>
