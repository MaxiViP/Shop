export interface NewOrdersSummary {
  count: number;
  latestOrderId: number | null;
}
export const emptyNewOrders = (): NewOrdersSummary => ({
  count: 0,
  latestOrderId: null,
});
export const newOrdersBadge = (count: number) =>
  count ? (count > 99 ? "99+" : String(count)) : "";

// Keeps the last successful counter throughout background requests and failures.
export function newOrdersLoader(
  load: () => Promise<NewOrdersSummary>,
  update: (value: NewOrdersSummary) => void,
) {
  let active = true;
  let busy = false;
  let again = false;
  let generation = 0;
  async function refresh() {
    if (!active) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const current = generation;
    try {
      const value = await load();
      if (active && current === generation) update(value);
    } catch {
      /* Leave the last known count in place. */
    } finally {
      busy = false;
      if (again) {
        again = false;
        void refresh();
      }
    }
  }
  return {
    refresh,
    reset() {
      generation++;
      update(emptyNewOrders());
    },
    dispose() {
      active = false;
      again = false;
    },
  };
}
