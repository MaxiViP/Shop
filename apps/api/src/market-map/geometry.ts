export const mapSize = { width: 1200, height: 1460 };
export const minHitSize = 12;
export const defaultHit = { width: 80, height: 92 };
const anchorY = 35 / 92;
export interface MapRect { x: number; y: number; width: number; height: number }
export interface MapGeometry {
  mapX: number | null; mapY: number | null; mapWidth?: number | null; mapHeight?: number | null;
}
export interface Escalator { x: number; y: number; width: number; length: number; rotation: number; published: boolean }
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const resizeHandles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function hitRect(point: MapGeometry): MapRect | null {
  if (point.mapX === null || point.mapY === null || !Number.isFinite(point.mapX) || !Number.isFinite(point.mapY)) return null;
  const width = point.mapWidth ?? defaultHit.width, height = point.mapHeight ?? defaultHit.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < minHitSize || height < minHitSize) return null;
  return { x: point.mapX * mapSize.width / 100 - width / 2,
    y: point.mapY * mapSize.height / 100 - height * anchorY, width, height };
}
export function rectPosition(rect: MapRect) {
  return { mapX: round((rect.x + rect.width / 2) / mapSize.width * 100),
    mapY: round((rect.y + rect.height * anchorY) / mapSize.height * 100),
    mapWidth: round(rect.width), mapHeight: round(rect.height) };
}
export function handlePosition(rect: MapRect, handle: ResizeHandle) {
  return { x: rect.x + (handle.includes('w') ? 0 : handle.includes('e') ? rect.width : rect.width / 2),
    y: rect.y + (handle.includes('n') ? 0 : handle.includes('s') ? rect.height : rect.height / 2) };
}
export function adjustRect(rect: MapRect, dx: number, dy: number, handle?: ResizeHandle): MapRect {
  let { x, y, width, height } = rect;
  if (!handle) { x += dx; y += dy; }
  else {
    if (handle.includes('w')) { width = Math.max(minHitSize, Math.min(mapSize.width, width - dx)); x = rect.x + rect.width - width; }
    if (handle.includes('e')) width = Math.max(minHitSize, Math.min(mapSize.width, width + dx));
    if (handle.includes('n')) { height = Math.max(minHitSize, Math.min(mapSize.height, height - dy)); y = rect.y + rect.height - height; }
    if (handle.includes('s')) height = Math.max(minHitSize, Math.min(mapSize.height, height + dy));
  }
  x = Math.max(-width / 2, Math.min(mapSize.width - width / 2, x));
  y = Math.max(-height * anchorY, Math.min(mapSize.height - height * anchorY, y));
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}
export const hitRadius = (rect: MapRect) => Math.min(10, rect.width / 2, rect.height / 2);
export function intersects(a: MapRect, b: MapRect) {
  if (a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height) return false;
  const ar = hitRadius(a), br = hitRadius(b);
  const dx = Math.max(0, b.x + br - (a.x + a.width - ar), a.x + ar - (b.x + b.width - br));
  const dy = Math.max(0, b.y + br - (a.y + a.height - ar), a.y + ar - (b.y + b.height - br));
  return dx * dx + dy * dy < (ar + br) ** 2;
}
export function mapConflicts(rows: { id: number; rect: MapRect }[]) {
  const conflicts = new Set<number>();
  const sorted = rows.toSorted((a, b) => a.rect.x - b.rect.x);
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!;
    for (let j = i + 1; j < sorted.length && sorted[j]!.rect.x < current.rect.x + current.rect.width; j++)
      if (intersects(current.rect, sorted[j]!.rect)) { conflicts.add(current.id); conflicts.add(sorted[j]!.id); }
  }
  return conflicts;
}
export function escalatorBounds(value: Escalator): MapRect {
  const angle = value.rotation * Math.PI / 180;
  const width = Math.abs(value.width * Math.cos(angle)) + Math.abs(value.length * Math.sin(angle));
  const height = Math.abs(value.width * Math.sin(angle)) + Math.abs(value.length * Math.cos(angle));
  return { x: value.x + (value.width - width) / 2, y: value.y + (value.length - height) / 2, width, height };
}
export function contrastColor(hex: string) {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return luminance > 0.179 ? '#000000' : '#FFFFFF';
}
