import type { HomeSlidesResponse } from '~/types/home-slide';
import { visibleHomeSlides } from '~/utils/home-slides';

export async function useHomeSlides() {
  const response = useApi<HomeSlidesResponse>('/home/slides', {
    key: 'home-slides', default: () => ({ slides: [], serverNow: '', validUntil: '' }),
  });
  const { data, refresh } = response;
  const now = ref<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let loading = false;
  function schedule() {
    clearTimeout(timer);
    if (disposed) return;
    const boundary = Date.parse(data.value.validUntil);
    const delay = Number.isFinite(boundary) ? Math.max(1000, Math.min(60_000, boundary - Date.now())) : 30_000;
    timer = setTimeout(() => { void update(); }, delay);
  }
  async function update() {
    if (disposed || loading) return;
    if (document.hidden) { timer = setTimeout(() => { void update(); }, 60_000); return; }
    loading = true;
    try { await refresh(); }
    finally { loading = false; schedule(); }
  }
  function resume() { if (!document.hidden) void update(); }
  onMounted(() => {
    now.value = Date.now();
    clock = setInterval(() => { now.value = Date.now(); }, 1000);
    schedule();
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
  });
  onBeforeUnmount(() => {
    disposed = true;
    clearTimeout(timer); clearInterval(clock);
    window.removeEventListener('focus', resume);
    document.removeEventListener('visibilitychange', resume);
  });
  const slides = computed(() => visibleHomeSlides(data.value, now.value));
  // Register lifecycle hooks before awaiting: a plain async composable does not restore Vue's instance.
  await response;
  return { slides };
}
