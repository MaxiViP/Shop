import { useAuthStore } from "~/stores/auth";
import { emptyNewOrders, newOrdersLoader } from "~/utils/new-orders";

export const useNewOrdersRevision = () =>
  useState("new-orders-revision", () => 0);
export function useNewOrders() {
  const auth = useAuthStore();
  const api = useApiClient();
  const revision = useNewOrdersRevision();
  const summary = ref(emptyNewOrders());
  const staff = computed(() =>
    ["SELLER", "ADMIN"].includes(auth.user?.role ?? ""),
  );
  let mounted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loader = newOrdersLoader(
    async () => {
      if (!staff.value || document.visibilityState !== "visible")
        throw new Error("inactive");
      return api("/staff/orders/new-summary");
    },
    (value) => {
      summary.value = value;
    },
  );
  const refresh = () =>
    mounted && staff.value && document.visibilityState === "visible"
      ? loader.refresh()
      : Promise.resolve();
  async function tick() {
    await refresh();
    if (mounted) timer = setTimeout(tick, 10000);
  }
  const wake = () => {
    void refresh();
  };
  watch(
    () => `${auth.user?.id}:${auth.user?.role}`,
    () => {
      loader.reset();
      wake();
    },
  );
  watch(revision, wake);
  onMounted(() => {
    mounted = true;
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    void tick();
  });
  onBeforeUnmount(() => {
    mounted = false;
    loader.dispose();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("focus", wake);
  });
  return computed(() => summary.value.count);
}
