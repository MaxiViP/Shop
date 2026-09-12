import { useAuthStore } from "~/stores/auth";
import { ordersAction } from "~/utils/orders-action";

// One state composition per layout; desktop/mobile presentations do not start polling.
export function useOrdersAction() {
  const auth = useAuthStore();
  const newOrders = useNewOrders();
  const communication = useCommunication();
  return computed(() =>
    ordersAction(
      ["SELLER", "ADMIN"].includes(auth.user?.role ?? ""),
      newOrders.value,
      communication.count.value,
      communication.latestOrderId.value,
    ),
  );
}
