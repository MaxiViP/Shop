<template>
  <main class="home">
    <UContainer class="home__inner">
      <h1 class="home__title">
        Свежие овощи и фрукты
      </h1>

      <p class="home__text">
        Доставка свежих продуктов с рынка по Москве.
      </p>

      <UButton label="В каталог" />
    </UContainer>
  </main>
</template>

<style scoped>
.home {
  min-height: 100vh;
}

.home__inner {
  padding-block: 4rem;
}

.home__title {
  font-size: 2rem;
  font-weight: 700;
}

.home__text {
  margin-block: 1rem 2rem;
}
</style>
