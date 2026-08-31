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
  padding-block: 3rem 5rem;
}

.delivery__title {
  font-size: 2.5rem;
  font-weight: 700;
}

.delivery__text {
  margin-top: 1rem;
  color: var(--ui-text-muted);
}
</style>
