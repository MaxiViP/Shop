<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script setup lang="ts">
import type { User } from '~/types/user'
import { useAuthStore } from '~/stores/auth'

const auth = useAuthStore()

const { data: user } = await useApi<User | null>('/auth/me', {
  default: () => null,
})

auth.set(user.value)
</script>
