<template>
  <UApp :locale="ru" :scroll-body="{ padding: 0, margin: 0 }" :toaster="{ position: 'top-left', max: 2, expand: false, ui: { viewport: 'order-toasts' } }">
    <AppOrderNotices />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>

<script setup lang="ts">
import { ru } from '@nuxt/ui/locale'
import type { User } from '~/types/user'
import { useAuthStore } from '~/stores/auth'
import { useCartStore } from '~/stores/cart'

const auth = useAuthStore()
const cart = useCartStore()
const faviconState = computed(() => cart.restored && cart.count > 0 ? "full" : "empty")
useHead(() => ({
  link: [16, 32, 48].map((size) => ({
    key: "cart-favicon-" + size,
    rel: "icon",
    type: "image/png",
    sizes: size + "x" + size,
    href: "/favicons/cart-" + faviconState.value + "-" + size + ".png",
  })),
}))

type BadgeNavigator = Navigator & {
  setAppBadge?: (count: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}
let stopBadge = () => {}
onMounted(() => {
  const badgeNavigator = navigator as BadgeNavigator
  stopBadge = watch(
    () => cart.restored ? cart.count : null,
    (count) => {
      if (count === null) return
      try {
        const task = count > 0
          ? badgeNavigator.setAppBadge?.(count)
          : badgeNavigator.clearAppBadge?.()
        void task?.catch(() => {})
      } catch {
        // Badging is optional and must not affect the cart.
      }
    },
    { immediate: true },
  )
})
onBeforeUnmount(() => stopBadge())
useSiteSeo()

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
