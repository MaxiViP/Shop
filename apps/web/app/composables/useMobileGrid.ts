export type MobileColumns = 2 | 3 | 4;
export function useMobileGrid(scope: 'catalog' | 'favorites' = 'catalog') {
  const key = scope === 'favorites' ? 'favorite-columns' : 'product-columns';
  const fallback = scope === 'favorites' ? 4 : 2;
  const saved = useCookie<number>(key, { default: () => fallback, sameSite: 'lax', maxAge: 31_536_000 });
  const columns = useState<MobileColumns>(key, () => saved.value === 2 || saved.value === 3 || saved.value === 4 ? saved.value : fallback);
  function select(value: MobileColumns) { columns.value = value; saved.value = value; }
  return { columns, select };
}
