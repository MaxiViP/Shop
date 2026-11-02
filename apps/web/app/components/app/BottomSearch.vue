<template>
  <form
    class="bottom-search"
    role="search"
    aria-label="Поиск товаров"
    @submit.prevent="submitSearch"
  >
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
      icon="i-lucide-search"
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
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex: 1;
  min-width: 0;
  max-width: 26.25rem;
  height: var(--bottom-control-height);
  min-height: var(--bottom-control-height);
  padding: 0.25rem 0.25rem 0.25rem 0.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 2rem;
  background: var(--search-background);
  color: #083344;
  box-shadow: 0 4px 24px #0002;
  pointer-events: auto;
}
.bottom-search__input {
  flex: 1;
  min-width: 0;
  min-height: var(--touch-target);
  padding: 0.5rem 0.25rem;
  font-size: 1rem;
  background: transparent;
  color: inherit;
  outline: none;
}
.bottom-search:focus-within {
  outline: 2px solid var(--ui-primary);
}
.bottom-search__input::placeholder {
  color: inherit;
  opacity: 0.85;
}
.bottom-search__input::-webkit-search-cancel-button {
  display: none;
}
.bottom-search__button {
  min-width: 44px;
  min-height: 44px;
  justify-content: center;
  border-radius: 50%;
  color: inherit;
}
</style>
