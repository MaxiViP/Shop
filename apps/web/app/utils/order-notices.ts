export interface OrderNotice {
  id: number;
  orderId: number;
  kind: string;
  title: string;
  to: string;
  createdAt: string;
}
export interface NoticeFeed { scope: string | null; events: OrderNotice[]; hasMore: boolean }

export function createNoticeDelivery(options: {
  fetch: () => Promise<NoticeFeed>;
  acknowledge: (ids: number[]) => Promise<unknown>;
  show: (notice: OrderNotice) => void;
  dismiss: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  exclusive?: (work: () => Promise<void>) => Promise<void>;
  visible?: () => boolean;
}) {
  let busy = false, generation = 0, scope: string | null = null;
  let shown = new Set<number>();
  const key = () => `order-notices:${scope}`;
  function changeScope(value: string | null) {
    scope = value;
    shown = new Set();
    options.dismiss();
  }
  function restoreShown() {
    try {
      const saved: unknown = JSON.parse(options.storage.getItem(key()) ?? '[]');
      if (Array.isArray(saved)) for (const id of saved)
        if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) shown.add(id);
    } catch { /* Server seen state still prevents replay when storage is unavailable. */ }
  }
  return {
    reset() { generation++; changeScope(null); },
    async poll() {
      if (busy) return;
      busy = true;
      const current = generation;
      const deliver = async () => {
        if (current !== generation || options.visible?.() === false) return;
        const feed = await options.fetch();
        if (current !== generation || options.visible?.() === false) return;
        if (scope !== feed.scope) changeScope(feed.scope);
        if (!scope) return;
        // Other tabs may have displayed this batch since our previous poll.
        restoreShown();
        const ids: number[] = [];
        for (const event of feed.events) {
          if (!shown.has(event.id)) {
            options.show(event);
            shown.add(event.id);
          }
          ids.push(event.id);
        }
        // Persist displayed IDs before acknowledgment: reload/reconnect can retry seen without another toast.
        try { options.storage.setItem(key(), JSON.stringify([...shown].slice(-500))); } catch { /* Storage is optional. */ }
        if (ids.length) await options.acknowledge([...new Set(ids)]);
      };
      try {
        if (options.exclusive) await options.exclusive(deliver);
        else await deliver();
      } finally { busy = false; }
    },
  };
}
