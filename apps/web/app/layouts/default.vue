<template>
  <div class="layout">
    <AppHeader />

    <main class="layout__main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.layout {
  min-height: 100vh;
}

.layout__main {
  min-height: calc(100vh - 72px);
}
</style>
