<template>
  <section class="map" aria-label="Интерактивная схема второго этажа">
    <div class="map__toolbar">
      <span class="map__floor">2 этаж</span>
      <div class="map__controls">
        <UButton icon="i-lucide-minus" color="neutral" variant="outline" aria-label="Уменьшить карту" :disabled="zoom <= 1" @click="changeZoom(-0.5)" />
        <span class="map__scale" aria-live="polite">{{ Math.round(zoom * 100) }}%</span>
        <UButton icon="i-lucide-plus" color="neutral" variant="outline" aria-label="Увеличить карту" :disabled="zoom >= maxZoom" @click="changeZoom(0.5)" />
        <UButton color="neutral" variant="ghost" @click="reset">Вся карта</UButton>
      </div>
    </div>
    <p class="map__hint">{{ placing ? 'Нажмите на схему, чтобы поставить выбранную точку.' : 'Нажмите на название точки. Увеличенную карту можно перемещать прокруткой или свайпом.' }}</p>
    <div ref="viewport" class="map__viewport" :class="{ 'map__viewport--placing': placing }" tabindex="0" aria-label="Карта: используйте прокрутку, чтобы перемещаться по схеме">
      <svg ref="drawing" class="map__drawing" :style="{ width: `${fitWidth * zoom}px` }" :viewBox="`0 0 ${mapSize.width} ${mapSize.height}`" role="group" aria-label="Магазины, лавки, фудкорт и входы на второй этаж" @click="place">
        <image :href="'/images/market/floor2.svg'" :width="mapSize.width" :height="mapSize.height" aria-hidden="true" />
        <component
          :is="editable ? 'g' : 'a'"
          v-for="{ point, x, y, lines, label, caption, displaced } in markers" :key="point.id"
          class="map__point" :class="[
            `map__point--${point.kind.toLowerCase()}`,
            { 'map__point--selected': point.id === selectedId, 'map__point--hidden': !point.isPublished },
          ]"
          :transform="`translate(${x} ${y})`"
          :href="editable ? undefined : `/market-map/${point.slug}`"
          :role="editable ? 'button' : undefined" :tabindex="editable ? 0 : undefined"
          :aria-label="`${marketPointLabel(point)} · ${marketKindLabels[point.kind]}${!point.isPublished && editable ? ' · скрыта' : ''}`"
          @click="select($event, point.id)" @keydown="keySelect($event, point.id)"
        >
          <title>{{ marketPointLabel(point) }}</title>
          <rect class="map__hit" x="-40" y="-35" width="80" height="92" rx="10" />
          <path v-if="displaced" class="map__leader" :d="`M0 0 L${label.x} ${label.y - 8}`" />
          <circle v-if="point.kind === 'ENTRY'" class="map__entry-zone" r="31" />
          <circle class="map__pin" :r="point.kind === 'ENTRY' ? 19 : 12" />
          <path v-if="point.kind === 'ENTRY'" class="map__arrow" d="M0 9V-9M-7-2L0-9L7-2" />
          <circle v-else class="map__dot" r="4" />
          <text v-if="point.unitNumber" class="map__number" x="17" y="-15" :text-anchor="point.mapX > 90 ? 'end' : 'start'">{{ point.unitNumber }}</text>
          <rect v-if="point.kind === 'ENTRY'" class="map__entry-label" :x="caption.x" :y="caption.y" :width="caption.width" :height="caption.height" rx="7" />
          <text class="map__name" :text-anchor="label.anchor">
            <tspan v-for="(line, index) in lines" :key="index" :x="label.x" :y="label.y + index * 17">{{ line }}</tspan>
          </text>
        </component>
      </svg>
    </div>
    <ul class="map__legend" aria-label="Обозначения карты">
      <li v-for="item in legend" :key="item.value"><span :class="`map__swatch map__swatch--${item.value.toLowerCase()}`" aria-hidden="true" />{{ item.label }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { MarketMarker } from '~/types/market-map';
import { mapLabels, mapPosition, mapSize, marketKinds, marketKindLabels, marketPointLabel } from '~/utils/market-map';
const props = withDefaults(defineProps<{
  points: MarketMarker[];
  editable?: boolean;
  placing?: boolean;
  selectedId?: number;
}>(), { editable: false, placing: false, selectedId: undefined });
const emit = defineEmits<{ select: [id: number]; place: [position: { mapX: number; mapY: number }] }>();
const viewport = ref<HTMLDivElement>();
const drawing = ref<SVGSVGElement>();
const zoom = ref(1);
const maxZoom = 5;
const fitWidth = ref(360);
const markers = computed(() => mapLabels(props.points));
const legend = marketKinds;
let observer: ResizeObserver | undefined;
function fit() {
  if (!viewport.value) return;
  fitWidth.value = Math.max(1, Math.min(viewport.value.clientWidth, viewport.value.clientHeight * mapSize.width / mapSize.height));
}
onMounted(() => {
  fit();
  observer = new ResizeObserver(fit);
  if (viewport.value) observer.observe(viewport.value);
});
onBeforeUnmount(() => observer?.disconnect());
async function changeZoom(delta: number) {
  const nextZoom = Math.max(1, Math.min(maxZoom, zoom.value + delta));
  if (nextZoom === zoom.value) return;
  const element = viewport.value;
  const width = fitWidth.value * zoom.value;
  const scale = width / mapSize.width;
  const center = element ? {
    x: (element.scrollLeft + element.clientWidth / 2 - Math.max(0, (element.clientWidth - width) / 2)) / scale,
    y: (element.scrollTop + element.clientHeight / 2) / scale,
  } : undefined;
  zoom.value = nextZoom;
  await nextTick();
  if (!element || !center) return;
  const nextWidth = fitWidth.value * zoom.value;
  const nextScale = nextWidth / mapSize.width;
  element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth,
    center.x * nextScale + Math.max(0, (element.clientWidth - nextWidth) / 2) - element.clientWidth / 2));
  element.scrollTop = Math.max(0, Math.min(element.scrollHeight - element.clientHeight,
    center.y * nextScale - element.clientHeight / 2));
}
async function reset() {
  zoom.value = 1;
  await nextTick();
  if (!viewport.value) return;
  viewport.value.scrollLeft = 0;
  viewport.value.scrollTop = 0;
}
function place(event: MouseEvent) {
  if (!props.editable || !props.placing || !drawing.value) return;
  const matrix = drawing.value.getScreenCTM();
  if (!matrix) return;
  const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const position = mapPosition(local.x, local.y);
  if (position) emit('place', position);
}
function select(event: MouseEvent, id: number) {
  if (!props.editable) return;
  event.stopPropagation();
  if (props.placing) { place(event); return; }
  emit('select', id);
}
function keySelect(event: KeyboardEvent, id: number) {
  if (!props.editable || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  emit('select', id);
}
</script>

<style scoped>
.map { min-width: 0; overflow: hidden; border: 1px solid var(--ui-border); border-radius: 1rem; background: var(--ui-bg-elevated); }
.map__toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; padding: .75rem; }
.map__floor { font-weight: 700; }
.map__controls { display: flex; align-items: center; flex-wrap: wrap; gap: .25rem; }
.map__controls :deep(button) { min-width: 44px; min-height: 44px; }
.map__scale { min-width: 3.25rem; text-align: center; font-size: .8125rem; }
.map__hint { padding: 0 .75rem .75rem; color: var(--ui-text-muted); font-size: .8125rem; line-height: 1.5; }
.map__viewport { aspect-ratio: 1200 / 1460; max-height: min(65dvh, 48rem); width: 100%; overflow: auto; background: #10191e; overscroll-behavior: contain; scrollbar-gutter: stable; }
.map__viewport--placing { cursor: crosshair; }
.map__viewport:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.map__drawing { display: block; max-width: none; height: auto; margin-inline: auto; aspect-ratio: 1200 / 1460; }
.map__point { --pin: #80c9a4; color: #ecf5f1; cursor: pointer; outline: none; }
.map__point--foodcourt { --pin: #edb86a; }
.map__point--store { --pin: #91bccc; }
.map__point--service, .map__point--other { --pin: #c4a4ef; }
.map__point--entry { --pin: #f7a284; }
.map__entry-zone { fill: #f7a284; fill-opacity: .12; stroke: #f7a284; stroke-width: 2; }
.map__point--entry .map__pin { fill: #f7a284; stroke: #10191e; stroke-width: 3; }
.map__point--entry .map__arrow { stroke: #10191e; stroke-width: 3; }
.map__entry-label { fill: #10191e; stroke: #f7a284; stroke-width: 1.5; }
.map__point--entry .map__name { fill: #ffbd9f; font-size: 16px; font-weight: 700; }
.map__point--hidden { opacity: .5; }
.map__hit { fill: transparent; stroke: transparent; stroke-width: 3; }
.map__point:hover .map__hit, .map__point:focus-visible .map__hit, .map__point--selected .map__hit { fill: #10191e; fill-opacity: .88; stroke: var(--pin); }
.map__pin { fill: #10191e; stroke: var(--pin); stroke-width: 2.5; }
.map__dot { fill: var(--pin); }
.map__leader { fill: none; stroke: var(--pin); stroke-width: 1; opacity: .65; }
.map__arrow { fill: none; stroke: var(--pin); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.map__name { fill: currentColor; font: 600 14px system-ui, sans-serif; paint-order: stroke; stroke: #10191e; stroke-width: 3px; stroke-linejoin: round; }
.map__number { fill: var(--pin); font: 700 17px system-ui, sans-serif; paint-order: stroke; stroke: #10191e; stroke-width: 3px; }
.map__legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; padding: .75rem; font-size: .75rem; color: var(--ui-text-muted); }
.map__legend li { display: flex; align-items: center; gap: .4rem; }
.map__swatch { width: .65rem; height: .65rem; border-radius: 50%; background: #80c9a4; }
.map__swatch--foodcourt { background: #edb86a; }
.map__swatch--store { background: #91bccc; }
.map__swatch--service, .map__swatch--other { background: #c4a4ef; }
.map__swatch--entry { background: #f7a284; }
</style>
