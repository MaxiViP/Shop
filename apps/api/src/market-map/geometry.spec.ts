import { adjustRect, contrastColor, escalatorBounds, handlePosition, hitRect, intersects, mapConflicts, rectPosition, resizeHandles } from './geometry.js';
import { escalatorSchema, pointPatch, pointSchema } from './schema.js';

describe('market geometry', () => {
  const rect = { x: 200, y: 300, width: 80, height: 92 };
  it('preserves the legacy hit rect and anchor with null dimensions', () => {
    expect(hitRect({ mapX: 20, mapY: 50 })).toEqual({ x: 200, y: 695, width: 80, height: 92 });
    const position = rectPosition(rect);
    const roundtrip = hitRect(position)!;
    expect(roundtrip.x).toBeCloseTo(rect.x, 4); expect(roundtrip.y).toBeCloseTo(rect.y, 4);
    expect(roundtrip.width).toBe(80); expect(roundtrip.height).toBe(92);
    expect(hitRect({ mapX: null, mapY: null })).toBeNull();
  });
  it.each(resizeHandles)('resizes the correct edges for %s without changing unrelated edges', handle => {
    const result = adjustRect(rect, 10, 20, handle);
    if (handle.includes('w')) { expect(result.width).toBe(70); expect(result.x).toBe(210); }
    else if (handle.includes('e')) { expect(result.width).toBe(90); expect(result.x).toBe(200); }
    else { expect(result.width).toBe(80); expect(result.x).toBe(200); }
    if (handle.includes('n')) { expect(result.height).toBe(72); expect(result.y).toBe(320); }
    else if (handle.includes('s')) { expect(result.height).toBe(112); expect(result.y).toBe(300); }
    else { expect(result.height).toBe(92); expect(result.y).toBe(300); }
    expect(handlePosition(rect, handle).x).toBeGreaterThanOrEqual(rect.x);
  });
  it('moves only the selected rect and clamps size/anchor consistently with the model', () => {
    expect(adjustRect(rect, 30, -40)).toEqual({ ...rect, x: 230, y: 260 });
    expect(rect).toEqual({ x: 200, y: 300, width: 80, height: 92 });
    const small = adjustRect(rect, 10000, 10000, 'nw');
    expect(small.width).toBe(12); expect(small.height).toBe(12);
    const bounded = rectPosition(adjustRect(rect, -10000, 10000));
    expect(bounded.mapX).toBe(0); expect(bounded.mapY).toBe(100);
  });
  it('detects actual rounded-rect intersections; edge touches and rounded-corner gaps are not conflicts', () => {
    expect(intersects(rect, { ...rect, x: 240 })).toBe(true);
    expect(intersects(rect, { ...rect, x: 280 })).toBe(false);
    expect(intersects(rect, { ...rect, x: 275, y: 387 })).toBe(false);
    expect(intersects(rect, { ...rect, x: 274, y: 386 })).toBe(true);
    expect([...mapConflicts([{ id: 1, rect }, { id: 2, rect: { ...rect, x: 240 } }, { id: 3, rect: { ...rect, x: 800 } }])].sort()).toEqual([1, 2]);
  });
  it('keeps the same result independently of screen zoom and uses contrasting ink', () => {
    for (const zoom of [0.25, 1, 2, 3, 5]) {
      const result = adjustRect(rect, 20 * zoom / zoom, 30 * zoom / zoom, 'se');
      expect(result).toEqual({ ...rect, width: 100, height: 122 });
    }
    expect(contrastColor('#FFFFFF')).toBe('#000000'); expect(contrastColor('#000000')).toBe('#FFFFFF');
  });
  it('validates presentation, paired dimensions, eligible shop kinds and rotated landmark bounds', () => {
    const point = { slug: 'test', name: 'Test', kind: 'STALL', mapX: 20, mapY: 30 };
    expect(pointSchema.parse({ ...point, mapColor: ' #aabbcc ', mapWidth: 80, mapHeight: 92 }).mapColor).toBe('#AABBCC');
    for (const change of [{ mapWidth: 0 }, { mapWidth: 80 }, { mapColor: 'red' }, { mapColor: '#123' }, { ourLabel: 'x'.repeat(81) }, { kind: 'ENTRY', isOurPoint: true }])
      expect(pointSchema.safeParse({ ...point, ...change }).success).toBe(false);
    expect(pointPatch.safeParse({ expectedUpdatedAt: '2026-10-08T00:00:00Z' }).success).toBe(false);
    const escalator = { x: 300, y: 300, width: 56, length: 300, rotation: 90, published: false };
    const bounds = escalatorBounds(escalator); expect(bounds.width).toBeCloseTo(300); expect(bounds.height).toBeCloseTo(56);
    expect(escalatorSchema.safeParse(escalator).success).toBe(true);
    expect(escalatorSchema.safeParse({ ...escalator, x: 0 }).success).toBe(false);
  });
});
