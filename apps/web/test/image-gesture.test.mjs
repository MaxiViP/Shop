import test from 'node:test';
import assert from 'node:assert/strict';
import { clampImageView, initialImageView, pinchImage, zoomImageAt } from '../app/utils/image-gesture.ts';

const bounds = { width: 400, height: 300, imageWidth: 800, imageHeight: 600 };

test('zoom clamps scale and pan to the fitted image bounds', () => {
  assert.deepEqual(clampImageView({ scale: 1, x: 99, y: -99 }, bounds), initialImageView());
  assert.deepEqual(clampImageView({ scale: 5, x: 999, y: -999 }, bounds),
    { scale: 4, x: 600, y: -450 });
  assert.deepEqual(clampImageView({ scale: 2, x: 999, y: -999 },
    { ...bounds, imageWidth: 200, imageHeight: 600 }), { scale: 2, x: 0, y: -150 });
});

test('pinch preserves its center and double-tap zoom can reset', () => {
  const first = pinchImage(initialImageView(), bounds, 100, { x: 200, y: 150 }, 200, { x: 200, y: 150 });
  assert.deepEqual(first, { scale: 2, x: 0, y: 0 });
  assert.deepEqual(zoomImageAt(first, bounds, 1, { x: 110, y: 100 }), initialImageView());
  const right = zoomImageAt(initialImageView(), bounds, 2, { x: 300, y: 150 });
  assert.equal(right.x, -100);
});
