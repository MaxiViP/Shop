import { useAuthStore } from '~/stores/auth'

export function useCheckoutName() {
  const auth = useAuthStore()
  const name = ref(auth.user?.name ?? '')
  const mounted = ref(false)
  const key = computed(() => auth.user
    ? `shop:checkout:name:user:${auth.user.id}`
    : 'shop:checkout:name:guest')

  function restore() {
    name.value = auth.user?.name ?? ''
    if (!import.meta.client || !mounted.value) return
    try {
      name.value = localStorage.getItem(key.value)?.trim() || name.value
    } catch {
      // Checkout remains available when browser storage is disabled.
    }
  }

  onMounted(() => {
    mounted.value = true
    restore()
  })
  watch(key, restore, { flush: 'sync' })

  // Capture both the submitted name and namespace before the request starts.
  function rememberOnSuccess() {
    const submittedKey = key.value
    const submittedName = name.value.trim()
    return () => {
      if (!import.meta.client || !submittedName) return
      try {
        localStorage.setItem(submittedKey, submittedName)
      } catch {
        // A storage error must not turn an accepted order into a failed checkout.
      }
    }
  }

  return { name, rememberOnSuccess }
}
