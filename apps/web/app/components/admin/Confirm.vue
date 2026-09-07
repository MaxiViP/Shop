<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :dismissible="!busy"
  >
    <template #footer>
      <UButton
        color="neutral"
        variant="outline"
        :disabled="busy"
        @click="open = false"
        >Отмена</UButton
      >
      <UButton color="error" :loading="busy" @click="$emit('confirm')"
        >Подтвердить</UButton
      >
    </template>
  </UModal>
</template>

<script setup lang="ts">
defineProps<{ title: string; description?: string; busy: boolean }>();
defineEmits<{ confirm: [] }>();
const open = defineModel<boolean>("open", { required: true });
</script>
