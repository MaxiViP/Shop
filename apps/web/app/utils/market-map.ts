import type { MarketMarker, MarketPoint, MarketPointKind } from '~/types/market-map';
import { mapSize } from '../../../api/src/market-map/geometry.ts';
export { mapSize };
export * from '../../../api/src/market-map/geometry.ts';

export const marketKindLabels: Record<MarketPointKind, string> = {
  STALL: 'Лавка', STORE: 'Магазин', FOODCOURT: 'Фудкорт',
  SERVICE: 'Сервис', OTHER: 'Другое', ENTRY: 'Вход',
};
export const marketKinds = Object.entries(marketKindLabels).map(([value, label]) => ({
  value: value as MarketPointKind, label,
}));
export function marketPointColor(point: Pick<MarketMarker, 'kind' | 'mapColor' | 'isOurPoint'>) {
  if (point.mapColor && /^#[0-9a-f]{6}$/i.test(point.mapColor)) return point.mapColor;
  if (point.isOurPoint) return '#00DC82';
  return point.kind === 'FOODCOURT' ? '#EDB86A' : point.kind === 'STORE' ? '#91BCCC' : point.kind === 'ENTRY' ? '#F7A284' : ['SERVICE', 'OTHER'].includes(point.kind) ? '#C4A4EF' : '#80C9A4';
}

export function marketPointLabel(point: Pick<MarketMarker, 'name' | 'unitNumber'>) {
  return point.unitNumber ? `${point.unitNumber} · ${point.name}` : point.name;
}

export function filterMarketPoints(points: MarketPoint[], query: string, kind = '') {
  const search = query.trim().toLocaleLowerCase('ru-RU');
  return points.filter(point => point.kind !== 'ENTRY' && (!kind || point.kind === kind)
    && (!search || [point.name, point.unitNumber, point.sampleAssortment]
      .some(value => value?.toLocaleLowerCase('ru-RU').includes(search))));
}

export function mapLabelLines(name: string) {
  const words = (name.trim() || 'Точка').split(/\s+/).flatMap(word => word.match(/.{1,14}/gu) ?? []);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > 14) { lines.push(line); line = word; }
    else line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.length > 3 ? [...lines.slice(0, 2), `${lines[2]}…`] : lines;
}

interface LabelBox { left: number; right: number; top: number; bottom: number }
const overlaps = (a: LabelBox, b: LabelBox) => a.left < b.right + 4 && a.right > b.left - 4
  && a.top < b.bottom + 4 && a.bottom > b.top - 4;

// Only captions move to avoid collisions; the actual point coordinates stay fixed.
export function mapLabels(points: MarketMarker[], obstacles: { x: number; y: number; width: number; height: number }[] = [], ourScale = 1) {
  const mapped = points.filter((point): point is MarketMarker & { mapX: number; mapY: number } =>
    point.mapX !== null && point.mapY !== null && Number.isFinite(point.mapX) && Number.isFinite(point.mapY));
  const pins = mapped.map(point => {
    const radius = point.kind === 'ENTRY' ? 32 : 14;
    const x = point.mapX * mapSize.width / 100, y = point.mapY * mapSize.height / 100;
    return { left: x - radius, right: x + radius, top: y - radius, bottom: y + radius };
  });
  const occupied: LabelBox[] = obstacles.map(rect => ({ left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height }));
  // Reserve entry captions first, then paint their markers above the trading points.
  const ordered = [...mapped.filter(point => point.isOurPoint), ...mapped.filter(point => !point.isOurPoint && point.kind === 'ENTRY'), ...mapped.filter(point => !point.isOurPoint && point.kind !== 'ENTRY')];
  const markers = ordered.map(point => {
    const x = point.mapX * mapSize.width / 100, y = point.mapY * mapSize.height / 100;
    const lines = mapLabelLines(point.isOurPoint ? point.ourLabel || 'Мы здесь!' : point.kind === 'ENTRY' ? `Вход на ${point.floor ?? 2} этаж` : point.name);
    const entry = point.kind === 'ENTRY';
    const scale = point.isOurPoint ? ourScale : 1;
    const padding = (entry || point.isOurPoint ? 6 : 0) * scale;
    const width = Math.max(...lines.map(line => line.length)) * (entry || point.isOurPoint ? 9 : 8) * scale;
    const height = (lines.length - 1) * 17 * scale;
    const below = (entry ? 56 : 32) * scale;
    const above = (entry ? -48 : -32) * scale - height;
    const anchor = x < 180 ? 'start' : x > 1080 ? 'end' : 'middle';
    const candidates = [
      { x: 0, y: below, anchor },
      { x: 0, y: above, anchor },
      { x: entry ? -42 : -26, y: 5, anchor: 'end' },
      { x: entry ? 42 : 26, y: 5, anchor: 'start' },
      { x: -26, y: above, anchor: 'end' },
      { x: 26, y: above, anchor: 'start' },
      { x: 0, y: below + 44, anchor },
      { x: -26, y: below + 24, anchor: 'end' },
      { x: 26, y: below + 24, anchor: 'start' },
      { x: 0, y: -82 - height, anchor },
      { x: -60, y: below, anchor: 'end' },
      { x: 60, y: below, anchor: 'start' },
      { x: -60, y: -82 - height, anchor: 'end' },
      { x: 60, y: -82 - height, anchor: 'start' },
      { x: -60, y: below + 44, anchor: 'end' },
      { x: 60, y: below + 44, anchor: 'start' },
      { x: 0, y: below + 76, anchor },
      { x: 0, y: -120 - height, anchor },
    ];
    const box = (label: typeof candidates[number]): LabelBox => {
      const left = x + label.x - (label.anchor === 'end' ? width : label.anchor === 'middle' ? width / 2 : 0);
      return { left: left - padding, right: left + width + padding,
        top: y + label.y - (entry || point.isOurPoint ? 16 : 13) * scale - padding, bottom: y + label.y + height + 4 * scale + padding };
    };
    const label = candidates.find(candidate => {
      const area = box(candidate);
      return area.left >= 8 && area.right <= mapSize.width - 8 && area.top >= 8
        && area.bottom <= mapSize.height - 8 && ![...pins, ...occupied].some(other => overlaps(area, other));
    }) ?? candidates[0]!;
    const area = box(label);
    occupied.push(area);
    return { point, x, y, lines, label, scale, displaced: label.x !== 0 || label.y !== below,
      caption: { x: area.left - x, y: area.top - y, width: area.right - area.left, height: area.bottom - area.top } };
  });
  return [...markers.filter(marker => !marker.point.isOurPoint && marker.point.kind !== 'ENTRY'), ...markers.filter(marker => !marker.point.isOurPoint && marker.point.kind === 'ENTRY'), ...markers.filter(marker => marker.point.isOurPoint)];
}

export function mapPosition(x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    mapX: Math.round(Math.max(0, Math.min(100, x / mapSize.width * 100)) * 100) / 100,
    mapY: Math.round(Math.max(0, Math.min(100, y / mapSize.height * 100)) * 100) / 100,
  };
}
