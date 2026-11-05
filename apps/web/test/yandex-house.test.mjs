import assert from 'node:assert/strict';
import test from 'node:test';
import { splitYandexHouse } from '../app/utils/yandex-house.ts';

test('splits Yandex house-with-corpus without changing the building identity', () => {
  for (const [number, house, buildingPart] of [
    ['53к1', '53', 'к1'],
    ['53 корп. 1', '53', 'корп. 1'],
    ['53 стр. 2', '53', 'стр. 2'],
    ['53с2', '53', 'с2'],
    ['53/1к2', '53/1', 'к2'],
  ]) {
    assert.deepEqual(splitYandexHouse(number), { house, buildingPart }, number);
  }
});

test('preserves ambiguous and lettered house numbers without guessing a corpus', () => {
  for (const number of ['53А', '53/1', '10-12', '53к', '3/2Б']) {
    assert.deepEqual(splitYandexHouse(number), { house: number, buildingPart: '' });
  }
});
