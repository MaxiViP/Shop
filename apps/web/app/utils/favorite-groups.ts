import type { ProductListItem } from '~/types/product';

export function favoriteGroups(items: ProductListItem[]) {
  const groups = new Map<string, { slug: string; name: string; items: ProductListItem[] }>();
  for (const item of items) {
    const category = item.category;
    let group = groups.get(category.slug);
    if (!group) {
      group = { slug: category.slug, name: category.name, items: [] };
      groups.set(category.slug, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
