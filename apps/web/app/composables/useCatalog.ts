import { queryText } from '~/utils/search';
import { catalogGroups } from '~/utils/catalog';
import { useProductSort } from '~/composables/useProductSort';

export async function useCatalog(category?: string) {
  const route = useRoute();
  const { search, q, submitSearch, clearSearch } = useProductSearch(true);
  const { sort, sortQuery } = useProductSort();
  const filters = computed(() => ({
    ...(q.value ? { q: q.value } : {}),
    ...(queryText(route.query.marketPoint) ? { marketPoint: queryText(route.query.marketPoint) } : {}),
    ...(queryText(route.query.ids) ? { ids: queryText(route.query.ids) } : {}),
  }));
  const categoryQuery = computed(() => ({ ...filters.value, ...sortQuery.value }));
  const feed = await useProductFeed(() => ({
    feed: 'catalog', category, ...filters.value, sort: sort.value, limit: 24,
  }), 'catalog-products:' + (category ?? 'all'));

  return { ...feed, search, q, sort, categoryQuery, submitSearch, clearSearch,
    groups: computed(() => category ? catalogGroups(feed.items.value) : []),
  };
}
