import { useAuthStore } from "~/stores/auth";

export const useCommunicationRevision = () =>
  useState("communication-revision", () => 0);

export function useCommunication() {
  const auth = useAuthStore();
  const api = useApiClient();
  const revision = useCommunicationRevision();
  const staff = computed(() =>
    ["SELLER", "ADMIN"].includes(auth.user?.role ?? ""),
  );
  const summary = ref<{ count: number; latestOrderId: string | number | null }>(
    { count: 0, latestOrderId: null },
  );
  let active = false;
  let busy = false;
  let again = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function refresh() {
    if (!active || document.visibilityState !== "visible") return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const current = generation;
    try {
      const result = await api<typeof summary.value>(
        staff.value ? "/staff/orders/unread" : "/orders/unread",
      );
      if (active && current === generation) summary.value = result;
    } catch {
      /* Keep the previous badge during a transient network failure. */
    } finally {
      busy = false;
      if (again) {
        again = false;
        void refresh();
      }
    }
  }
  async function tick() {
    await refresh();
    if (active) timer = setTimeout(tick, 10000);
  }
  const wake = () => {
    void refresh();
  };
  watch(
    () => `${auth.user?.id ?? ""}:${auth.user?.role ?? ""}`,
    () => {
      generation++;
      summary.value = { count: 0, latestOrderId: null };
      wake();
    },
  );
  watch(revision, wake);
  onMounted(() => {
    active = true;
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    void tick();
  });
  onBeforeUnmount(() => {
    active = false;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
  });
  return {
    count: computed(() => summary.value.count),
    to: computed(() =>
      summary.value.latestOrderId
        ? `${staff.value ? "/staff/orders" : "/order"}/${summary.value.latestOrderId}`
        : staff.value
          ? "/staff/orders"
          : "/orders",
    ),
  };
}
