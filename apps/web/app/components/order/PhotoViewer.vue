<template>
  <div
    ref="viewport"
    class="photo-viewer"
    tabindex="0"
    aria-label="Большое фото. Двумя пальцами увеличьте и переместите; двойное касание меняет масштаб. Escape закрывает."
    @pointerdown="pointerDown"
    @pointermove="pointerMove"
    @pointerup="pointerEnd"
    @pointercancel="pointerEnd"
    @dblclick.prevent="doubleClick"
    @keydown="keyDown"
  >
    <img
      :src="src"
      alt="Фото в сообщении крупным планом"
      draggable="false"
      class="photo-viewer__image"
      :style="{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }"
      @load="imageLoaded"
    >
    <UButton class="photo-viewer__close" type="button" icon="i-lucide-x" color="neutral" aria-label="Закрыть фото" @click="emit('close')" />
    <div class="photo-viewer__controls">
      <UButton type="button" size="sm" color="neutral" variant="soft" icon="i-lucide-minus" aria-label="Уменьшить фото" :disabled="view.scale <= 1" @click="zoom(1 / 1.5)" />
      <UButton type="button" size="sm" color="neutral" variant="soft" icon="i-lucide-plus" aria-label="Увеличить фото" :disabled="view.scale >= 4" @click="zoom(1.5)" />
      <UButton v-if="view.scale > 1" type="button" size="sm" color="neutral" variant="soft" @click="reset">Сбросить</UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { clampImageView, initialImageView, pinchImage, zoomImageAt,
  type ImageBounds, type ImagePoint } from '~/utils/image-gesture';

defineProps<{ src: string }>();
const emit = defineEmits<{ close: [] }>();
const viewport = ref<HTMLElement>();
const view = ref(initialImageView());
const bounds = reactive<ImageBounds>({ width: 0, height: 0, imageWidth: 0, imageHeight: 0 });
const pointers = new Map<number, ImagePoint>();
let panStart: { point: ImagePoint; x: number; y: number } | null = null;
let pinchStart: { view: typeof view.value; distance: number; center: ImagePoint } | null = null;
let lastTap: { at: number; point: ImagePoint } | null = null;
let lastTouchToggle = 0;
let moved = false;
let observer: ResizeObserver | null = null;

function measure() {
  if (!viewport.value) return;
  bounds.width = viewport.value.clientWidth;
  bounds.height = viewport.value.clientHeight;
  view.value = clampImageView(view.value, bounds);
}
function imageLoaded(event: Event) {
  const image = event.target as HTMLImageElement;
  bounds.imageWidth = image.naturalWidth;
  bounds.imageHeight = image.naturalHeight;
  measure();
}
function point(event: PointerEvent): ImagePoint {
  const rect = viewport.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function centerAndDistance() {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return null;
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(a.x - b.x, a.y - b.y) };
}
function pointerDown(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest('button')) return;
  viewport.value?.setPointerCapture(event.pointerId);
  const at = point(event);
  pointers.set(event.pointerId, at);
  moved = false;
  if (pointers.size === 1) panStart = { point: at, x: view.value.x, y: view.value.y };
  if (pointers.size === 2) {
    const pair = centerAndDistance()!;
    pinchStart = { view: { ...view.value }, ...pair };
    panStart = null;
  }
}
function pointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  const at = point(event);
  pointers.set(event.pointerId, at);
  if (pointers.size >= 2 && pinchStart) {
    const pair = centerAndDistance();
    if (pair) view.value = pinchImage(pinchStart.view, bounds, pinchStart.distance,
      pinchStart.center, pair.distance, pair.center);
    moved = true;
  } else if (panStart && view.value.scale > 1) {
    const dx = at.x - panStart.point.x;
    const dy = at.y - panStart.point.y;
    if (Math.hypot(dx, dy) > 4) moved = true;
    view.value = clampImageView({ ...view.value, x: panStart.x + dx, y: panStart.y + dy }, bounds);
  }
}
function pointerEnd(event: PointerEvent) {
  const at = pointers.get(event.pointerId);
  if (!at) return;
  const wasPinch = Boolean(pinchStart);
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 1) {
    const remaining = [...pointers.values()][0]!;
    panStart = { point: remaining, x: view.value.x, y: view.value.y };
  } else if (!pointers.size) panStart = null;
  if (event.type === 'pointercancel' || event.pointerType !== 'touch' || moved || wasPinch) {
    lastTap = null;
    return;
  }
  const now = Date.now();
  if (lastTap && now - lastTap.at < 300 && Math.hypot(at.x - lastTap.point.x, at.y - lastTap.point.y) < 30) {
    toggleZoom(at);
    lastTouchToggle = now;
    lastTap = null;
  } else lastTap = { at: now, point: at };
}
function toggleZoom(at: ImagePoint) {
  view.value = view.value.scale > 1 ? initialImageView() : zoomImageAt(view.value, bounds, 2.5, at);
}
function doubleClick(event: MouseEvent) {
  // Some WebViews dispatch dblclick after the touch pointer sequence.
  if (Date.now() - lastTouchToggle < 350) return;
  if (event.target instanceof Element && event.target.closest('button')) return;
  const rect = viewport.value!.getBoundingClientRect();
  toggleZoom({ x: event.clientX - rect.left, y: event.clientY - rect.top });
}
function zoom(factor: number) {
  view.value = zoomImageAt(view.value, bounds, view.value.scale * factor,
    { x: bounds.width / 2, y: bounds.height / 2 });
}
function reset() { view.value = initialImageView(); }
function keyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') { emit('close'); return; }
  if (event.key === '+' || event.key === '=') zoom(1.5);
  else if (event.key === '-') zoom(1 / 1.5);
  else if (event.key === '0') reset();
  else if (event.key.startsWith('Arrow')) {
    const step = 45;
    view.value = clampImageView({ ...view.value,
      x: view.value.x + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0),
      y: view.value.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0) }, bounds);
  } else return;
  event.preventDefault();
}
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure);
    if (viewport.value) observer.observe(viewport.value);
  }
  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', orientationChanged);
});
function orientationChanged() {
  reset();
  requestAnimationFrame(measure);
}
onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener('resize', measure);
  window.removeEventListener('orientationchange', orientationChanged);
});
</script>

<style scoped>
.photo-viewer {
  position: relative;
  width: 100%;
  height: min(78dvh, 55rem);
  min-height: 14rem;
  overflow: hidden;
  border-radius: 0.75rem;
  background: #0b1220;
  touch-action: none;
  cursor: grab;
}
.photo-viewer:active { cursor: grabbing; }
.photo-viewer:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.photo-viewer__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  will-change: transform;
}
.photo-viewer__close {
  position: absolute;
  z-index: 2;
  top: 0.5rem;
  right: 0.5rem;
  min-width: var(--touch-target);
  min-height: var(--touch-target);
}
.photo-viewer__controls {
  position: absolute;
  z-index: 2;
  bottom: 0.5rem;
  left: 50%;
  display: flex;
  gap: 0.375rem;
  transform: translateX(-50%);
}
.photo-viewer__controls :deep(button) { min-width: var(--touch-target); min-height: var(--touch-target); }
</style>
