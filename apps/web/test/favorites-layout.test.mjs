import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { favoriteGroups } from '../app/utils/favorite-groups.ts';

test('favorites group only present categories in the existing item order', () => {
  const product = (id, slug, name) => ({ id, category: { slug, name } });
  const groups = favoriteGroups([
    product(7, 'fruit', 'Фрукты'), product(3, 'vegetables', 'Овощи'),
    product(2, 'fruit', 'Фрукты'), product(9, 'vegetables', 'Овощи'),
  ]);
  assert.deepEqual(groups.map(group => [group.slug, group.items.map(item => item.id)]), [
    ['fruit', [7, 2]], ['vegetables', [3, 9]],
  ]);
  assert.deepEqual(favoriteGroups([]), []);
});

test('compact favorites retain photo, favorite action, price, and cart controls', async () => {
  const source = path => readFile(new URL(`../app/${path}`, import.meta.url), 'utf8');
  const [page, grid, card] = await Promise.all([
    source('pages/favorites.vue'), source('components/product/Grid.vue'), source('components/product/Card.vue'),
  ]);
  assert.match(page, /v-for="group in groups"/);
  assert.match(page, /<ProductGrid :items="group\.items" compact/);
  assert.match(grid, /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(grid, /:compact="compact"/);
  for (const element of ['card__img', '<ProductFavorite', '<ProductPrice', 'card__add', 'card__control'])
    assert.ok(card.includes(element));
  assert.match(card, /card--compact/);
});
