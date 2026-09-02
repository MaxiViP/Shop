<template>
  <UContainer class="orders">
    <header class="orders__head">
      <p class="orders__label">
        Покупки
      </p>

      <h1 class="orders__title">
        Мои заказы
      </h1>
    </header>

    <OrderList />
  </UContainer>
</template>

<script setup lang="ts">
useSeoMeta({
  title: 'Мои заказы',
})
</script>

<style scoped>
.orders {
  max-width: 56.25rem;
  padding-block: var(--page-start) var(--page-end);
}

.orders__head {
  margin-bottom: 2rem;
}

.orders__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.orders__title {
  margin-top: 0.25rem;
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
}
</style>
