<template>
  <UContainer class="delivery">
    <h1 class="delivery__title">
      Доставка и самовывоз
    </h1>

    <p class="delivery__text">
      Условия доставки скоро появятся здесь.
    </p>
  </UContainer>
</template>

<script setup lang="ts">
useSeoMeta({
  title: 'Доставка и самовывоз',
})
</script>

<style scoped>
.delivery {
  padding-block: var(--page-start) var(--page-end);
}

.delivery__title {
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
}

.delivery__text {
  margin-top: 1rem;
  color: var(--ui-text-muted);
}
</style>
