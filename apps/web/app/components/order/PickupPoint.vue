<template>
  <div class="pickup-point">
    <strong>{{ config.public.pickupName }}</strong>
    <p>{{ config.public.pickupAddress }}</p>
  </div>
</template>

<script setup lang="ts">
const config = useRuntimeConfig()
</script>

<style scoped>
.pickup-point {
  display: grid;
  gap: 0.5rem;
  overflow-wrap: anywhere;
}
</style>
