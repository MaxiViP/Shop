import type { ProductSort } from '~/types/product';

export const productSortOptions: { label: string; value: ProductSort; icon: string }[] = [
  { label: 'Рекомендуемые', value: 'recommended', icon: 'i-lucide-sparkles' },
  { label: 'Сначала дешевле', value: 'price_asc', icon: 'i-lucide-arrow-down-wide-narrow' },
  { label: 'Сначала дороже', value: 'price_desc', icon: 'i-lucide-arrow-up-wide-narrow' },
  { label: 'Новинки', value: 'newest', icon: 'i-lucide-clock' },
  { label: 'По названию', value: 'name', icon: 'i-lucide-a-large-small' },
];

export function useProductSort() {
  const route = useRoute(), router = useRouter();
  const sort = computed<ProductSort>({
    get: () => productSortOptions.find(option => option.value === route.query.sort)?.value ?? 'recommended',
    set: value => { void setSort(value); },
  });
  const sortQuery = computed(() => {
    const query: Record<string, string> = {};
    if (sort.value !== 'recommended') query.sort = sort.value;
    return query;
  });
  async function setSort(value: ProductSort) {
    if (value === sort.value) return;
    const query = { ...route.query };
    delete query.page;
    delete query.cursor;
    if (value === 'recommended') delete query.sort;
    else query.sort = value;
    await router.replace({ query });
  }
  return { sort, sortQuery };
}
