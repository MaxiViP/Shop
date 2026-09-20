<template>
  <ClientOnly>
    <UDropdownMenu :items="items" :content="{ align: 'end' }" :modal="false">
      <UButton
        class="theme-control"
        type="button"
        color="neutral"
        variant="ghost"
        :icon="selected.icon"
        :aria-label="`Тема: ${selected.label.toLowerCase()}`"
        :title="`Тема: ${selected.label.toLowerCase()}`"
        :disabled="colorMode.forced"
      />
    </UDropdownMenu>
    <template #fallback>
      <UButton
        class="theme-control"
        type="button"
        color="neutral"
        variant="ghost"
        icon="i-lucide-monitor"
        aria-label="Выбор темы"
        disabled
      />
    </template>
  </ClientOnly>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
const colorMode = useColorMode();
const options = [
  { value: "system", label: "Системная", icon: "i-lucide-monitor" },
  { value: "light", label: "Светлая", icon: "i-lucide-sun" },
  { value: "dark", label: "Тёмная", icon: "i-lucide-moon" },
] as const;
const selected = computed(
  () =>
    options.find((option) => option.value === colorMode.preference) ??
    options[0],
);
const items = computed<DropdownMenuItem[]>(() =>
  options.map((option) => ({
    label: option.label,
    icon: option.icon,
    type: "checkbox",
    checked: colorMode.preference === option.value,
    onSelect: () => {
      colorMode.preference = option.value;
    },
  })),
);
</script>

<style scoped>
.theme-control {
  min-width: 44px;
  min-height: 44px;
  flex-shrink: 0;
  justify-content: center;
}
</style>
