import type {
  ProductListItem,
  ProductListResponse,
  ProductSort,
} from "~/types/product";

const limit = 24;

export const productSortOptions: { label: string; value: ProductSort }[] = [
  { label: "Рекомендуемые", value: "recommended" },
  { label: "Сначала дешевле", value: "price_asc" },
  { label: "Сначала дороже", value: "price_desc" },
  { label: "Новинки", value: "newest" },
  { label: "По названию", value: "name" },
];

const sorts = new Set<ProductSort>(
  productSortOptions.map(({ value }) => value),
);

function queryText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function querySort(value: unknown): ProductSort {
  return typeof value === "string" && sorts.has(value as ProductSort)
    ? (value as ProductSort)
    : "recommended";
}

export async function useCatalog(category?: string) {
  const route = useRoute();
  const router = useRouter();
  const api = useApiClient();
  const search = ref(queryText(route.query.q));
  const page = ref(1);
  const items = ref<ProductListItem[]>([]);
  const total = ref(0);
  const pages = ref(0);
  const loadingMore = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const q = computed(() => queryText(route.query.q));
  const sort = computed<ProductSort>({
    get: () => querySort(route.query.sort),
    set: (value) => {
      void setSort(value);
    },
  });
  const requestQuery = computed(() => ({
    q: q.value || undefined,
    category,
    sort: sort.value,
    page: 1,
    limit,
  }));
  const categoryQuery = computed(() => ({
    ...(q.value ? { q: q.value } : {}),
    ...(sort.value === "recommended" ? {} : { sort: sort.value }),
  }));

  const { data, status, error, refresh } = await useApi<ProductListResponse>(
    "/products",
    {
      key: `catalog-products:${category ?? "all"}`,
      query: requestQuery,
      watch: false,
      default: () => ({ items: [], total: 0, page: 1, limit, pages: 0 }),
    },
  );

  apply(data.value);

  const hasMore = computed(() => page.value < pages.value);

  watch(search, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void setSearch(search.value);
    }, 300);
  });

  watch(
    () => `${q.value}\u0000${sort.value}`,
    async () => {
      if (search.value !== q.value) search.value = q.value;
      page.value = 1;
      items.value = [];
      await refresh();
      if (!error.value) apply(data.value);
    },
  );

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
  });

  function apply(response: ProductListResponse) {
    items.value = response.items;
    total.value = response.total;
    page.value = response.page;
    pages.value = response.pages;
  }

  async function updateQuery(values: { q?: string; sort?: ProductSort }) {
    const query = { ...route.query };
    delete query.page;

    if ("q" in values) {
      const value = queryText(values.q);
      if (value) query.q = value;
      else delete query.q;
    }

    if (values.sort) {
      if (values.sort === "recommended") delete query.sort;
      else query.sort = values.sort;
    }

    await router.replace({ query });
  }

  async function setSearch(value: string) {
    const normalized = queryText(value);
    if (normalized === q.value) return;
    await updateQuery({ q: normalized });
  }

  function submitSearch() {
    if (timer) clearTimeout(timer);
    void setSearch(search.value);
  }

  function clearSearch() {
    search.value = "";
    if (timer) clearTimeout(timer);
    void setSearch("");
  }

  async function setSort(value: ProductSort) {
    if (value === sort.value) return;
    await updateQuery({ sort: value });
  }

  async function loadMore() {
    if (loadingMore.value || !hasMore.value) return;

    loadingMore.value = true;
    const requestKey = `${category ?? ""}\u0000${q.value}\u0000${sort.value}`;

    try {
      const response = await api<ProductListResponse>("/products", {
        query: {
          q: q.value || undefined,
          category,
          sort: sort.value,
          page: page.value + 1,
          limit,
        },
      });
      const currentKey = `${category ?? ""}\u0000${q.value}\u0000${sort.value}`;
      if (requestKey !== currentKey) return;

      const ids = new Set(items.value.map(({ id }) => id));
      items.value = [
        ...items.value,
        ...response.items.filter(({ id }) => !ids.has(id)),
      ];
      total.value = response.total;
      page.value = response.page;
      pages.value = response.pages;
    } finally {
      loadingMore.value = false;
    }
  }

  return {
    search,
    q,
    sort,
    categoryQuery,
    items,
    total,
    status,
    error,
    loadingMore,
    hasMore,
    submitSearch,
    clearSearch,
    loadMore,
  };
}
