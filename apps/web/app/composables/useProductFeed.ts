import type { MaybeRefOrGetter } from 'vue';
import type { ProductFeedQuery, ProductListItem, ProductListResponse } from '~/types/product';

export async function useProductFeed(query: MaybeRefOrGetter<ProductFeedQuery>, key: string) {
  const api = useApiClient();
  const requestQuery = computed(() => ({ ...toValue(query) }));
  const items = ref<ProductListItem[]>([]);
  const total = ref(0);
  const cursor = ref<string | null>(null);
  const status = ref<'pending' | 'success' | 'error'>('pending');
  const error = shallowRef<unknown>(null);
  const stale = ref(false);
  const loadingMore = ref(false);
  let generation = 0;
  let controller: AbortController | undefined;

  onScopeDispose(() => { generation++; controller?.abort(); });
  watch(() => JSON.stringify(requestQuery.value), () => { void reset(); }, { flush: 'sync' });

  // Nuxt transfers the first page and its server seed/cursor in the SSR payload.
  const initial = await useApi<ProductListResponse>('/products', {
    key, query: requestQuery, watch: false,
    default: () => ({ items: [], total: 0, page: 1, limit: requestQuery.value.limit, pages: 0 }),
  });
  if (generation === 0) {
    apply(initial.data.value, false);
    error.value = initial.error.value;
    status.value = initial.error.value ? 'error' : 'success';
  }

  function apply(response: ProductListResponse, append: boolean) {
    const seen = new Set(append ? items.value.map(item => item.id) : []);
    const fresh = response.items.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    items.value = append ? [...items.value, ...fresh] : fresh;
    total.value = response.total;
    cursor.value = response.nextCursor ?? null;
  }

  async function request(append: boolean) {
    const current = generation;
    const at = append ? cursor.value : null;
    const abort = new AbortController();
    controller = abort;
    error.value = null;
    if (append) loadingMore.value = true;
    else status.value = 'pending';
    try {
      const response = await api<ProductListResponse>('/products', {
        query: { ...requestQuery.value, ...(at ? { cursor: at } : {}) }, signal: abort.signal,
      });
      if (current !== generation || abort.signal.aborted) return;
      if (at && response.nextCursor === at) throw new Error('Product pagination did not advance');
      apply(response, append);
      status.value = 'success';
    } catch (cause: unknown) {
      if (current !== generation || abort.signal.aborted) return;
      error.value = cause;
      stale.value = typeof cause === 'object' && cause !== null && 'statusCode' in cause && cause.statusCode === 409;
      status.value = 'error';
    } finally {
      if (current === generation) { loadingMore.value = false; controller = undefined; }
    }
  }

  async function reset() {
    generation++;
    controller?.abort();
    items.value = [];
    cursor.value = null;
    stale.value = false;
    loadingMore.value = false;
    await request(false);
  }
  async function loadMore() {
    if (loadingMore.value || status.value === 'pending' || !cursor.value) return;
    await request(true);
  }
  const retry = () => !stale.value && items.value.length && cursor.value ? loadMore() : reset();
  return { items, total, status, error, stale, loadingMore, hasMore: computed(() => cursor.value !== null), loadMore, retry, restart: reset };
}
