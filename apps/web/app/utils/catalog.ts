import type { ProductListItem } from '~/types/product';

export function catalogGroups(items: ProductListItem[]) {
  const groups = new Map<string, { key: string; label: string; items: ProductListItem[] }>();
  for (const item of items) {
    let group = groups.get(item.category.slug);
    if (!group) {
      group = { key: item.category.slug, label: item.category.name, items: [] };
      groups.set(group.key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
export function visibleCategory(groups: { slug: string; top: number; bottom: number }[], anchor: number, height: number) {
  const visible = groups.filter(group => group.bottom > anchor && group.top < height);
  // A few remaining pixels of the preceding row should not mask the next group.
  const current = visible.find(group => Math.min(group.bottom, height) - Math.max(group.top, anchor) >= 80);
  return current?.slug ?? visible[0]?.slug;
}
