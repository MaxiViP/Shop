<template>
  <div />
</template>

<script setup lang="ts">
definePageMeta({
  middleware: () => navigateTo("/cart", { replace: true }),
});
</script>
