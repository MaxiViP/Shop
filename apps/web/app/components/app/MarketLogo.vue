<template>
  <span class="market-logo" aria-hidden="true">
    <span class="market-logo__full"><span class="market-logo__korzina">Korzina</span><span class="market-logo__market">Market</span></span>
  </span>
</template>

<script setup lang="ts">
</script>

<style scoped>
.market-logo {
  display: inline-flex;
  min-width: 44px;
  min-height: 44px;
  align-items: center;
  white-space: nowrap;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  font-weight: 800;
  line-height: 1;
}

.market-logo__full {
  display: inline-flex;
  font-size: clamp(0.875rem, calc(0.45rem + 1.8vw), 1.45rem);
  letter-spacing: -0.055em;
}

.market-logo__korzina {
  color: var(--ui-success);
}

.market-logo__market {
  color: var(--ui-text);
}

</style>
