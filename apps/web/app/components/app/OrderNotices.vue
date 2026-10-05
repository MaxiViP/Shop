<template><span class="sr-only" /></template>

<script setup lang="ts">
import { createNoticeDelivery, type NoticeFeed } from '~/utils/order-notices';
import { useAuthStore } from '~/stores/auth';
const api = useApiClient();
const auth = useAuthStore();
const toast = useToast();
const communication = useCommunicationRevision();
let delivery: ReturnType<typeof createNoticeDelivery> | undefined;
let active = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const displayed = new Set<string>();
function dismiss() { for (const id of displayed) toast.remove(id); displayed.clear(); }
async function poll() {
  if (!active || document.visibilityState !== 'visible') return;
  try { await delivery?.poll(); } catch { /* Pending events and local IDs survive reconnect. */ }
}
async function tick() {
  await poll();
  if (active) timer = setTimeout(tick, 4500);
}
const wake = () => { void poll(); };
watch(() => `${auth.user?.id ?? ''}:${auth.user?.role ?? ''}`, () => { delivery?.reset(); wake(); });
watch(communication, wake);
onMounted(() => {
  active = true;
  delivery = createNoticeDelivery({
    fetch: () => api<NoticeFeed>('/notifications', { query: { limit: 2 }, timeout: 10000 }),
    acknowledge: ids => api('/notifications/seen', { method: 'POST', body: { ids }, timeout: 10000 }),
    visible: () => active && document.visibilityState === 'visible',
    exclusive: async work => {
      if (navigator.locks) await navigator.locks.request('korzina:order-notices', work);
      else await work();
    },
    storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    dismiss,
    show: event => {
      const id = `order-event:${event.id}`;
      displayed.add(id);
      toast.add({ id, title: event.title, duration: 4500, close: true, progress: false,
        icon: ['CHAT_MESSAGE', 'CHAT_IMAGE_REVISION'].includes(event.kind) ? 'i-lucide-message-circle' : 'i-lucide-package',
        onClick: () => { toast.remove(id); void navigateTo(event.to); },
        actions: [{ label: 'Открыть', to: event.to, onClick: () => toast.remove(id) }],
        "onUpdate:open": open => { if (!open) displayed.delete(id); },
      });
    },
  });
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  void tick();
});
onBeforeUnmount(() => {
  active = false;
  delivery?.reset();
  clearTimeout(timer);
  document.removeEventListener('visibilitychange', wake);
  window.removeEventListener('focus', wake);
  window.removeEventListener('online', wake);
});
</script>

<style scoped></style>
