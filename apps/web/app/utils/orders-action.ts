export function ordersAction(
  staff: boolean,
  newCount: number,
  unread: number,
  latestOrderId: string | number | null,
) {
  const parts = [
    ...(staff && newCount ? [`новых ${newCount}`] : []),
    ...(unread ? [`непрочитанных сообщений ${unread}`] : []),
  ];
  const name = staff ? "Заказы" : "Мои заказы";
  return {
    name,
    newOrdersCount: staff ? newCount : 0,
    unreadMessagesCount: unread,
    label: parts.length ? `${name}: ${parts.join(", ")}` : name,
    to: !staff
      ? "/orders"
      : newCount > 0
        ? "/staff/orders?tab=new"
        : unread > 0 && latestOrderId !== null
          ? `/staff/orders/${latestOrderId}`
          : "/staff/orders",
  };
}
