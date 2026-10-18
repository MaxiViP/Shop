import { isStaff } from '~/utils/permissions';
import { useAuthStore } from "~/stores/auth";
import { ordersAction } from "~/utils/orders-action";

// One state composition per layout; desktop/mobile presentations do not start polling.
export function useOrdersAction() {
  const auth = useAuthStore();
  const newOrders = useNewOrders();
  const communication = useCommunication();
  return computed(() =>
    ordersAction(
      isStaff(auth.user),
      newOrders.value,
      communication.count.value,
      communication.latestOrderId.value,
    ),
  );
}
