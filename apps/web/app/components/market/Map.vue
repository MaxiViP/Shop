<template>
  <section class="map" :aria-label="`Интерактивная схема этажа ${floor}`">
    <div class="map__toolbar">
      <span class="map__floor">{{ floor }} этаж</span>
      <div class="map__controls">
        <UButton v-if="ourMarker" icon="i-lucide-map-pin" color="neutral" variant="soft" :disabled="!!drag" @click="findUs">Где мы?</UButton>
        <UButton icon="i-lucide-minus" color="neutral" variant="outline" aria-label="Уменьшить карту" :disabled="zoom <= 1 || !!drag" @click="changeZoom(-0.5)" />
        <span class="map__scale" aria-live="polite">{{ Math.round(zoom * 100) }}%</span>
        <UButton icon="i-lucide-plus" color="neutral" variant="outline" aria-label="Увеличить карту" :disabled="zoom >= maxZoom || !!drag" @click="changeZoom(0.5)" />
        <UButton color="neutral" variant="ghost" :disabled="!!drag" @click="reset">Вся карта</UButton>
      </div>
    </div>
    <p class="map__hint">{{ placing ? 'Нажмите на схему, чтобы поставить выбранный объект.' : editingEnabled ? 'Перетащите выбранную область или маркер её границы. Escape отменяет текущее перетаскивание.' : 'Нажмите на название точки. Увеличенную карту можно перемещать прокруткой или свайпом.' }}</p>
    <p v-if="floor !== 2" class="map__hint">Фоновая схема этого этажа ещё не добавлена. Показаны только координаты, заданные администратором.</p>
    <p v-if="editable && showBounds && conflicts.size" class="map__warning" role="status">Есть пересечения интерактивных областей: {{ conflicts.size }} точек. Проверьте красные контуры. Сохранение разрешено.</p>
    <div ref="viewport" class="map__viewport" :class="{ 'map__viewport--placing': placing }" tabindex="0" aria-label="Карта: используйте прокрутку, чтобы перемещаться по схеме">
      <svg ref="drawing" class="map__drawing" :style="{ width: `${fitWidth * zoom}px` }" :viewBox="`0 0 ${mapSize.width} ${mapSize.height}`" role="group" aria-label="Магазины, лавки, фудкорт и ориентиры" @click="place" @pointermove="movePointer" @pointerup="endPointer" @pointercancel="cancelPointer" @keydown.esc="cancelPointer">
        <image v-if="floor === 2" href="/images/market/floor2.svg" :width="mapSize.width" :height="mapSize.height" aria-hidden="true" />
        <g v-if="floor === 2 && !escalator" class="map__legacy-escalator" transform="translate(495 690)" aria-label="Эскалатор">
          <rect x="-16" y="-15" width="32" height="30" rx="5" />
          <path d="M-11 8H-7L7-6H11M-11 2H-8L5-11H11" />
          <text y="34" text-anchor="middle">Эскалатор</text>
        </g>
        <g v-if="escalator" class="map__escalator" :class="{ 'map__escalator--draft': !escalator.published }" :transform="`translate(${escalator.x} ${escalator.y}) rotate(${escalator.rotation} ${escalator.width / 2} ${escalator.length / 2})`" role="img" aria-label="Эскалатор">
          <rect class="map__escalator-track" x="0" y="0" :width="escalator.width * 0.35" :height="escalator.length" rx="5" />
          <rect class="map__escalator-track" :x="escalator.width * 0.65" y="0" :width="escalator.width * 0.35" :height="escalator.length" rx="5" />
          <text class="map__direction" :x="escalator.width * 0.175" :y="escalator.length * 0.25" aria-hidden="true">↑</text>
          <text class="map__direction" :x="escalator.width * 0.825" :y="escalator.length * 0.75" aria-hidden="true">↓</text>
          <g :transform="`rotate(${-escalator.rotation} ${escalator.width / 2} ${escalator.length / 2})`">
            <rect class="map__escalator-caption" :x="(escalator.width - escalatorCaption.width) / 2" :y="(escalator.length - escalatorCaption.height) / 2" :width="escalatorCaption.width" :height="escalatorCaption.height" rx="5" />
            <text class="map__escalator-name" :x="escalator.width / 2" :y="escalator.length / 2" :style="{ fontSize: `${escalatorFont}px` }">Эскалатор</text>
          </g>
        </g>
        <component
:is="editable ? 'g' : 'a'" v-for="{ point, x, y, lines, label, caption, displaced, scale } in markers" :key="point.id"
          class="map__point" :class="[`map__point--${point.kind.toLowerCase()}`, { 'map__point--selected': point.id === selected, 'map__point--hidden': !point.isPublished, 'map__point--ours': point.isOurPoint, 'map__point--boundary': editable && showBounds, 'map__point--conflict': editable && showBounds && conflicts.has(point.id), 'map__point--draggable': editingEnabled && point.id === selectedId }]"
          :style="{ '--pin': pointColor(point) }" :transform="`translate(${x} ${y})`" :href="editable ? undefined : `/market-map/${point.slug}`" :role="editable ? 'button' : undefined" :tabindex="editable ? 0 : undefined"
          :aria-label="`${marketPointLabel(point)} · ${marketKindLabels[point.kind]}${point.isOurPoint ? ' · ' + (point.ourLabel || 'Мы здесь!') : ''}${!point.isPublished && editable ? ' · скрыта' : ''}`" @click="select($event, point.id)" @keydown="keySelect($event, point.id)" @pointerdown="startPointer($event, point.id)">
          <title>{{ marketPointLabel(point) }}</title>
          <rect class="map__hit" :x="(hitRect(point)?.x ?? x - 40) - x" :y="(hitRect(point)?.y ?? y - 35) - y" :width="hitRect(point)?.width ?? 80" :height="hitRect(point)?.height ?? 92" :rx="hitRect(point) ? hitRadius(hitRect(point)!) : 10" :style="areaStyle(point)" />
          <path v-if="displaced" class="map__leader" :d="`M0 0 L${label.x} ${label.y - 8}`" />
          <circle v-if="point.kind === 'ENTRY'" class="map__entry-zone" r="31" />
          <circle class="map__pin" :r="point.kind === 'ENTRY' ? 19 : point.isOurPoint ? Math.max(12, 8 / screenScale) : 12" :style="point.isOurPoint ? { fill: pointColor(point), stroke: contrastColor(pointColor(point)) } : undefined" />
          <path v-if="point.kind === 'ENTRY'" class="map__arrow" d="M0 9V-9M-7-2L0-9L7-2" />
          <circle v-else class="map__dot" r="4" :style="point.isOurPoint ? { fill: contrastColor(pointColor(point)) } : undefined" />
          <text v-if="point.unitNumber" class="map__number" x="17" y="-15" :text-anchor="point.mapX > 90 ? 'end' : 'start'">{{ point.unitNumber }}</text>
          <rect v-if="point.kind === 'ENTRY' || point.isOurPoint" :class="point.isOurPoint ? 'map__our-caption' : 'map__entry-label'" :x="caption.x" :y="caption.y" :width="caption.width" :height="caption.height" rx="7" :style="point.isOurPoint ? { fill: pointColor(point), stroke: contrastColor(pointColor(point)) } : undefined" />
          <text class="map__name" :text-anchor="label.anchor" :style="point.isOurPoint ? { fontSize: `${16 * scale}px`, fill: contrastColor(pointColor(point)), stroke: 'none' } : undefined">
            <tspan v-for="(line, index) in lines" :key="index" :x="label.x" :y="label.y + index * 17 * scale">{{ line }}</tspan>
          </text>
        </component>
        <g v-if="editingEnabled && selectedRect" class="map__handles" aria-label="Изменение размеров выбранной точки">
          <g v-for="handle in resizeHandles" :key="handle" class="map__handle" :class="`map__handle--${handle}`" :data-handle="handle" :transform="`translate(${handlePosition(selectedRect, handle).x} ${handlePosition(selectedRect, handle).y})`" role="button" tabindex="0" :aria-label="`Изменить размер: ${handle}`" @pointerdown.stop="startPointer($event, selectedId ?? 0, handle)" @keydown="handleKey($event, handle)">
            <circle class="map__handle-hit" :r="14 / screenScale" />
            <circle class="map__handle-dot" :r="5 / screenScale" />
          </g>
        </g>
      </svg>
    </div>
    <ul class="map__legend" aria-label="Обозначения карты">
      <li v-for="item in legend" :key="item.value"><span :class="`map__swatch map__swatch--${item.value.toLowerCase()}`" aria-hidden="true" />{{ item.label }}</li>
      <li v-if="ourMarker"><span class="map__swatch" :style="{ background: pointColor(ourMarker.point) }" />{{ ourMarker.point.ourLabel || 'Мы здесь!' }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { MarketMarker } from '~/types/market-map';
import { mapLabels, mapPosition, mapSize, marketKinds, marketKindLabels, marketPointLabel,
  hitRect, hitRadius, rectPosition, adjustRect, handlePosition, resizeHandles, mapConflicts, intersects, escalatorBounds, contrastColor, marketPointColor as pointColor } from '~/utils/market-map';
import type { MapRect, MapGeometry, ResizeHandle, Escalator } from '~/utils/market-map';
const props = withDefaults(defineProps<{ points: MarketMarker[]; editable?: boolean; placing?: boolean; selectedId?: number; editing?: boolean; showBounds?: boolean; disabled?: boolean; floor?: number; escalator?: Escalator | null }>(),
  { editable: false, placing: false, selectedId: undefined, editing: false, showBounds: false, disabled: false, floor: 2, escalator: null });
const emit = defineEmits<{ select: [id: number]; place: [position: { mapX: number; mapY: number }]; geometry: [position: MapGeometry] }>();
const viewport = ref<HTMLDivElement>();
const drawing = ref<SVGSVGElement>();
const zoom = ref(1), maxZoom = 5, fitWidth = ref(360);
const focusedId = ref<number>();
const selected = computed(() => focusedId.value ?? props.selectedId);
const editingEnabled = computed(() => props.editable && !props.disabled && !props.placing && (props.editing || props.showBounds));
const screenScale = computed(() => Math.max(0.01, fitWidth.value * zoom.value / mapSize.width));
const ourScale = computed(() => Math.max(1, Math.min(5, 1 / screenScale.value)));
const escalatorFont = computed(() => Math.max(18, Math.min(48, 12 / screenScale.value)));
const escalatorCaption = computed(() => ({ width: escalatorFont.value * 5.6 + 12, height: escalatorFont.value + 12 }));
const obstacles = computed(() => props.escalator ? [escalatorBounds(props.escalator), { x: props.escalator.x + (props.escalator.width - escalatorCaption.value.width) / 2,
  y: props.escalator.y + (props.escalator.length - escalatorCaption.value.height) / 2, ...escalatorCaption.value }] : []);
const others = computed<MarketMarker[]>((previous) => {
  const next = props.points.filter(point => point.id !== props.selectedId && (point.floor == null || point.floor === props.floor));
  return previous && previous.length === next.length && next.every((point, index) => point === previous[index]) ? previous : next;
});
const baseMarkers = computed(() => mapLabels(others.value, obstacles.value, ourScale.value));
const currentPoint = computed(() => props.points.find(point => point.id === props.selectedId && (point.floor == null || point.floor === props.floor)));
const selectedRect = computed(() => currentPoint.value ? hitRect(currentPoint.value) : null);
const markers = computed(() => {
  if (!props.editable || !currentPoint.value) return mapLabels(props.points.filter(point => point.floor == null || point.floor === props.floor), obstacles.value, ourScale.value);
  return [...baseMarkers.value, ...mapLabels([currentPoint.value], obstacles.value, ourScale.value)];
});
const ourMarker = computed(() => markers.value.find(marker => marker.point.isOurPoint));
const baseRects = computed(() => others.value.flatMap(point => { const rect = hitRect(point); return rect ? [{ id: point.id, rect }] : []; }));
const baseConflicts = computed(() => props.editable && props.showBounds ? mapConflicts(baseRects.value) : new Set<number>());
const conflicts = computed(() => {
  const ids = new Set(baseConflicts.value);
  if (props.editable && props.showBounds && selectedRect.value) for (const row of baseRects.value)
    if (intersects(selectedRect.value, row.rect)) { ids.add(row.id); ids.add(props.selectedId ?? 0); }
  return ids;
});
const legend = marketKinds;
let observer: ResizeObserver | undefined;
type Drag = { pointer: number; x: number; y: number; rect: MapRect; initial: MapGeometry; handle?: ResizeHandle };
const drag = shallowRef<Drag | null>(null);
let suppressClick = false;
let clickTimer: ReturnType<typeof setTimeout> | undefined;
function areaStyle(point: MarketMarker) {
  if (props.editable && props.showBounds) return { fill: pointColor(point), fillOpacity: point.id === props.selectedId ? 0.12 : 0.025,
    stroke: conflicts.value.has(point.id) ? '#FF6363' : point.id === props.selectedId ? '#00DC82' : pointColor(point), strokeOpacity: point.id === props.selectedId ? 1 : 0.55 };
  if (point.isOurPoint || point.mapColor && /^#[0-9a-f]{6}$/i.test(point.mapColor)) return { fill: pointColor(point), fillOpacity: point.isOurPoint ? 0.32 : 0.18,
    stroke: point.isOurPoint ? contrastColor(pointColor(point)) : pointColor(point) };
  return undefined;
}
function fit() {
  if (!viewport.value) return;
  fitWidth.value = Math.max(1, Math.min(viewport.value.clientWidth, viewport.value.clientHeight * mapSize.width / mapSize.height));
}
onMounted(() => { fit(); observer = new ResizeObserver(fit); if (viewport.value) observer.observe(viewport.value); });
onBeforeUnmount(() => { observer?.disconnect(); cancelPointer(); });
watch(() => props.selectedId, () => { focusedId.value = undefined; });
async function changeZoom(delta: number) {
  const nextZoom = Math.max(1, Math.min(maxZoom, zoom.value + delta));
  if (nextZoom === zoom.value || drag.value) return;
  const element = viewport.value, width = fitWidth.value * zoom.value, scale = width / mapSize.width;
  const center = element ? { x: (element.scrollLeft + element.clientWidth / 2 - Math.max(0, (element.clientWidth - width) / 2)) / scale,
    y: (element.scrollTop + element.clientHeight / 2) / scale } : undefined;
  zoom.value = nextZoom; await nextTick();
  if (!element || !center) return;
  const nextWidth = fitWidth.value * zoom.value, nextScale = nextWidth / mapSize.width;
  element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, center.x * nextScale + Math.max(0, (element.clientWidth - nextWidth) / 2) - element.clientWidth / 2));
  element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, center.y * nextScale - element.clientHeight / 2));
}
async function reset() { if (drag.value) return; zoom.value = 1; await nextTick(); if (viewport.value) { viewport.value.scrollLeft = 0; viewport.value.scrollTop = 0; } }
async function findUs() {
  const marker = ourMarker.value; if (!marker || drag.value) return;
  if (props.editable) emit('select', marker.point.id); else focusedId.value = marker.point.id;
  zoom.value = Math.max(2.5, zoom.value); await nextTick();
  const element = viewport.value; if (!element) return;
  const width = fitWidth.value * zoom.value, scale = width / mapSize.width;
  element.scrollTo({ left: Math.max(0, marker.x * scale + Math.max(0, (element.clientWidth - width) / 2) - element.clientWidth / 2),
    top: Math.max(0, marker.y * scale - element.clientHeight / 2), behavior: 'smooth' });
}
function localPoint(event: { clientX: number; clientY: number }) {
  const matrix = drawing.value?.getScreenCTM();
  return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
}
function place(event: MouseEvent) {
  if (!props.editable || !props.placing || suppressClick) return;
  const local = localPoint(event); const position = local ? mapPosition(local.x, local.y) : null;
  if (position) emit('place', position);
}
function select(event: MouseEvent, id: number) {
  if (!props.editable) return;
  event.stopPropagation();
  if (suppressClick) { suppressClick = false; return; }
  if (props.placing) { place(event); return; }
  emit('select', id);
}
function keySelect(event: KeyboardEvent, id: number) {
  if (!props.editable || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault(); emit('select', id);
}
function startPointer(event: PointerEvent, id: number, handle?: ResizeHandle) {
  if (!editingEnabled.value || event.button !== 0 || drag.value) return;
  clearTimeout(clickTimer); suppressClick = false;
  if (id !== props.selectedId) { emit('select', id); return; }
  const rect = selectedRect.value, local = localPoint(event);
  if (!rect || !local || !drawing.value) return;
  event.preventDefault(); event.stopPropagation(); drawing.value.setPointerCapture(event.pointerId);
  const point = currentPoint.value!;
  drag.value = { pointer: event.pointerId, x: local.x, y: local.y, rect, handle,
    initial: { mapX: point.mapX, mapY: point.mapY, mapWidth: point.mapWidth ?? null, mapHeight: point.mapHeight ?? null } }; suppressClick = false;
  (event.currentTarget as SVGElement | null)?.focus?.({ preventScroll: true });
  window.addEventListener('keydown', dragEscape);
}
function dragEscape(event: KeyboardEvent) { if (drag.value && event.key === 'Escape') { event.preventDefault(); cancelPointer(); } }
function movePointer(event: PointerEvent) {
  const state = drag.value; if (!state || state.pointer !== event.pointerId) return;
  const local = localPoint(event); if (!local) return;
  event.preventDefault(); const dx = local.x - state.x, dy = local.y - state.y;
  if (Math.abs(dx) + Math.abs(dy) < 0.0001) return;
  if (Math.abs(dx) + Math.abs(dy) > 0.1) suppressClick = true;
  emit('geometry', rectPosition(adjustRect(state.rect, dx, dy, state.handle)));
}
function endPointer(event: PointerEvent) {
  if (drag.value?.pointer !== event.pointerId) return;
  if (drawing.value?.hasPointerCapture(event.pointerId)) drawing.value.releasePointerCapture(event.pointerId);
  drag.value = null;
  window.removeEventListener('keydown', dragEscape);
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => { suppressClick = false; clickTimer = undefined; }, 0);
}
function cancelPointer() {
  clearTimeout(clickTimer); clickTimer = undefined; suppressClick = false;
  if (import.meta.client) window.removeEventListener('keydown', dragEscape);
  const state = drag.value; if (!state) return;
  emit('geometry', state.initial);
  if (drawing.value?.hasPointerCapture(state.pointer)) drawing.value.releasePointerCapture(state.pointer);
  drag.value = null; suppressClick = false;
}
function handleKey(event: KeyboardEvent, handle: ResizeHandle) {
  if (!editingEnabled.value || !selectedRect.value || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1;
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  emit('geometry', rectPosition(adjustRect(selectedRect.value, dx, dy, handle)));
}
</script>

<style scoped>
.map { min-width: 0; overflow: hidden; border: 1px solid var(--ui-border); border-radius: 1rem; background: var(--ui-bg-elevated); }
.map__toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; padding: .75rem; }
.map__floor { font-weight: 700; }
.map__controls { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem; }
.map__controls :deep(button) { min-width: 44px; min-height: 44px; }
.map__scale { min-width: 3.25rem; text-align: center; font-size: .8125rem; }
.map__hint, .map__warning { padding: 0 .75rem .75rem; color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.5; }
.map__warning { color: var(--ui-error); }
.map__viewport { aspect-ratio: 1200 / 1460; max-height: min(65dvh, 48rem); width: 100%; overflow: auto; background: #10191e; scrollbar-gutter: stable; }
.map__viewport--placing { cursor: crosshair; }
.map__viewport:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.map__drawing { display: block; max-width: none; height: auto; margin-inline: auto; aspect-ratio: 1200 / 1460; }
.map__point { --pin: #80c9a4; color: #ecf5f1; cursor: pointer; outline: none; }
.map__point--entry { --pin: #f7a284; }
.map__entry-zone { fill: #f7a284; fill-opacity: .12; stroke: #f7a284; stroke-width: 2; }
.map__point--entry .map__pin { fill: #f7a284; stroke: #10191e; stroke-width: 3; }
.map__point--entry .map__arrow { stroke: #10191e; stroke-width: 3; }
.map__entry-label { fill: #10191e; stroke: #f7a284; stroke-width: 1.5; }
.map__point--entry .map__name { fill: #ffbd9f; font-size: 16px; font-weight: 700; }
.map__point--hidden { opacity: .5; }
.map__hit { fill: transparent; stroke: transparent; stroke-width: 3; }
.map__point:hover .map__hit, .map__point:focus-visible .map__hit, .map__point--selected .map__hit { fill: #10191e; fill-opacity: .88; stroke: var(--pin); }
.map__point--boundary .map__hit { vector-effect: non-scaling-stroke; stroke-width: 1; }
.map__point--boundary.map__point--selected .map__hit { stroke-width: 2; }
.map__point--conflict .map__hit { stroke-dasharray: 5 3; }
.map__point--ours .map__hit, .map__our-caption { vector-effect: non-scaling-stroke; stroke-width: 1.5; }
.map__point--ours .map__pin { filter: drop-shadow(0 0 7px var(--pin)); }
.map__point--ours:hover .map__hit, .map__point--ours:focus-visible .map__hit { filter: brightness(1.12); }
.map__point--draggable { cursor: move; touch-action: none; }
.map__pin { fill: #10191e; stroke: var(--pin); stroke-width: 2.5; }
.map__dot { fill: var(--pin); }
.map__leader { fill: none; stroke: var(--pin); stroke-width: 1; opacity: .65; }
.map__arrow { fill: none; stroke: var(--pin); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.map__name { fill: currentColor; font: 600 14px system-ui, sans-serif; paint-order: stroke; stroke: #10191e; stroke-width: 3px; stroke-linejoin: round; }
.map__number { fill: var(--pin); font: 700 17px system-ui, sans-serif; paint-order: stroke; stroke: #10191e; stroke-width: 3px; }
.map__handle { outline: none; touch-action: none; }
.map__handle-hit { fill: transparent; }
.map__handle-dot { fill: #fff; stroke: #00dc82; stroke-width: 2; vector-effect: non-scaling-stroke; }
.map__handle:focus-visible .map__handle-dot { fill: #00dc82; stroke: #fff; }
.map__handle--nw, .map__handle--se { cursor: nwse-resize; }
.map__handle--ne, .map__handle--sw { cursor: nesw-resize; }
.map__handle--n, .map__handle--s { cursor: ns-resize; }
.map__handle--e, .map__handle--w { cursor: ew-resize; }
.map__escalator-track { fill: #203b33; stroke: #b6c8c3; stroke-width: 2; vector-effect: non-scaling-stroke; }
.map__escalator--draft { opacity: .65; }
.map__direction { fill: #eff8f4; font: 700 30px system-ui; text-anchor: middle; dominant-baseline: middle; }
.map__escalator-caption { fill: #10191e; stroke: #b6c8c3; stroke-width: 1; vector-effect: non-scaling-stroke; }
.map__escalator-name { fill: #eff8f4; font-family: system-ui; text-anchor: middle; dominant-baseline: middle; }
.map__legacy-escalator { stroke: #8ba49a; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.map__legacy-escalator rect { fill: #10191e; }
.map__legacy-escalator text { fill: #8ba49a; stroke: none; font: 14px system-ui; }
.map__legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; padding: .75rem; font-size: .75rem; color: var(--ui-text-muted); }
.map__legend li { display: flex; align-items: center; gap: .4rem; }
.map__swatch { width: .65rem; height: .65rem; border-radius: 50%; background: #80c9a4; }
.map__swatch--foodcourt { background: #edb86a; }
.map__swatch--store { background: #91bccc; }
.map__swatch--service, .map__swatch--other { background: #c4a4ef; }
.map__swatch--entry { background: #f7a284; }
</style>
