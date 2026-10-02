export interface ImageView { scale: number; x: number; y: number }
export interface ImageBounds { width: number; height: number; imageWidth: number; imageHeight: number }
export interface ImagePoint { x: number; y: number }

export const initialImageView = (): ImageView => ({ scale: 1, x: 0, y: 0 });
const limit = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function clampImageView(view: ImageView, bounds: ImageBounds): ImageView {
  const scale = limit(view.scale, 1, 4);
  if (scale === 1 || !bounds.width || !bounds.height || !bounds.imageWidth || !bounds.imageHeight)
    return initialImageView();
  const fit = Math.min(bounds.width / bounds.imageWidth, bounds.height / bounds.imageHeight);
  const maxX = Math.max(0, (bounds.imageWidth * fit * scale - bounds.width) / 2);
  const maxY = Math.max(0, (bounds.imageHeight * fit * scale - bounds.height) / 2);
  return { scale, x: limit(view.x, -maxX, maxX), y: limit(view.y, -maxY, maxY) };
}

export function zoomImageAt(view: ImageView, bounds: ImageBounds, scale: number, point: ImagePoint): ImageView {
  const ratio = limit(scale, 1, 4) / view.scale;
  const centeredX = point.x - bounds.width / 2;
  const centeredY = point.y - bounds.height / 2;
  return clampImageView({ scale, x: centeredX - (centeredX - view.x) * ratio,
    y: centeredY - (centeredY - view.y) * ratio }, bounds);
}

export function pinchImage(view: ImageView, bounds: ImageBounds, startDistance: number,
  startCenter: ImagePoint, distance: number, center: ImagePoint): ImageView {
  if (startDistance <= 0) return view;
  const scale = limit(view.scale * distance / startDistance, 1, 4);
  const ratio = scale / view.scale;
  return clampImageView({ scale,
    x: center.x - bounds.width / 2 - (startCenter.x - bounds.width / 2 - view.x) * ratio,
    y: center.y - bounds.height / 2 - (startCenter.y - bounds.height / 2 - view.y) * ratio }, bounds);
}
