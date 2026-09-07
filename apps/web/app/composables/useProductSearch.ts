import { queryText, searchQuery, searchPath, isCatalog } from "~/utils/search";
import type { LocationQueryRaw } from "vue-router";

export function useProductSearch(debounce = false) {
  const route = useRoute();
  const router = useRouter();
  const search = useState("product-search", () => queryText(route.query.q));
  const q = computed(() => queryText(route.query.q));
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(
    () => route.fullPath,
    () => {
      clearTimeout(timer);
      search.value = q.value;
    },
    { immediate: true },
  );
  if (debounce)
    watch(search, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void submitSearch();
      }, 300);
    });
  onBeforeUnmount(() => clearTimeout(timer));

  async function submitSearch() {
    clearTimeout(timer);
    const value = queryText(search.value);
    if (isCatalog(route.path) && value === q.value) return;
    const target = {
      path: searchPath(route.path),
      query: searchQuery(
        isCatalog(route.path) ? route.query : {},
        value,
      ) as LocationQueryRaw,
    };
    if (isCatalog(route.path)) await router.replace(target);
    else await router.push(target);
  }
  function clearSearch() {
    search.value = "";
    return submitSearch();
  }
  return { search, q, submitSearch, clearSearch };
}
