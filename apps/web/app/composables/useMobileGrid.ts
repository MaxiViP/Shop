export type MobileColumns = 2 | 3 | 4;
export function useMobileGrid() {
  const saved = useCookie<number>('product-columns', { default: () => 2, sameSite: 'lax', maxAge: 31_536_000 });
  const columns = useState<MobileColumns>('product-columns', () => saved.value === 3 || saved.value === 4 ? saved.value : 2);
  function select(value: MobileColumns) { columns.value = value; saved.value = value; }
  return { columns, select };
}
