<template>
  <UApp :locale="ru">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script setup lang="ts">
import { ru } from '@nuxt/ui/locale'
import type { User } from '~/types/user'
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()

useHead({
  htmlAttrs: {
    lang: "ru-RU",
    dir: "ltr",
  },
  meta: [
    {
      property: "og:locale",
      content: "ru_RU",
    },
  ],
})

const { data: user } = await useApi<User | null>('/auth/me', {
  default: () => null,
})

auth.set(user.value)
</script>
