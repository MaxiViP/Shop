import type { Ref } from 'vue';

// Measured rows keep their space when cards outside the viewport are unmounted.
// Data remains in the feed; returning to a row reuses its original products and order.
export function useGridWindow(root: Ref<HTMLElement | null>, count: () => number, enabled: () => boolean) {
  const start = ref(0), end = ref(count()), top = ref(0), bottom = ref(0);
  const heights = new Map<number, number>();
  let columns = 0, width = 0, estimate = 400, gap = 0, frame = 0, near = true, revision = 0;
  let anchor: { index: number; top: number } | undefined;
  let layoutAnchor: typeof anchor, restoring = 0;
  let observer: ResizeObserver | undefined, visibility: IntersectionObserver | undefined;
  function reset() { start.value = 0; end.value = count(); top.value = 0; bottom.value = 0; }
  function sum(from: number, to: number) { let result = 0; for (let row = from; row < to; row++) result += heights.get(row) ?? estimate; return result; }
  function visibleAnchor() {
    if (!root.value) return;
    for (const card of document.querySelectorAll<HTMLElement>('[data-product-index]')) {
      const box = card.getBoundingClientRect();
      if (box.top >= 160 && box.top < window.innerHeight)
        return root.value.contains(card) ? { index: Number(card.dataset.productIndex), top: box.top } : undefined;
    }
  }
  function measure() {
    frame = 0;
    const element = root.value; if (!element) return;
    const style = getComputedStyle(element), nextColumns = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const box = element.getBoundingClientRect();
    const changed = columns > 0 && (nextColumns !== columns || Math.abs(box.width - width) > 0.5);
    // Rendered rows and neighbouring groups settle over successive resize frames.
    if (changed) { layoutAnchor = anchor; restoring = layoutAnchor ? 4 : 0; }
    const preserved = restoring ? layoutAnchor : visibleAnchor();
    gap = parseFloat(style.rowGap) || 0;
    if (changed) heights.clear();
    columns = nextColumns;
    width = box.width;
    const measured = new Map<number, number>();
    for (const card of element.querySelectorAll<HTMLElement>('[data-product-index]')) {
      const row = Math.floor(Number(card.dataset.productIndex) / columns);
      measured.set(row, Math.max(measured.get(row) ?? 0, card.getBoundingClientRect().height));
    }
    // A column change may briefly leave the old slice starting inside a new row.
    if (start.value % columns === 0) for (const [row, height] of measured) if (height > 0) heights.set(row, height);
    const samples = heights.size ? heights : measured;
    if (samples.size) estimate = [...samples.values()].toSorted((a, b) => a - b)[Math.floor(samples.size / 2)]!;
    if (!enabled()) { reset(); anchor = visibleAnchor(); return; }
    const rows = Math.ceil(count() / columns);
    const from = Math.max(0, -box.top - 900), to = Math.max(0, window.innerHeight - box.top + 900);
    let first = 0, offset = 0;
    while (first < rows && offset + (heights.get(first) ?? estimate) + gap < from) { offset += (heights.get(first) ?? estimate) + gap; first++; }
    let last = first, tail = offset;
    while (last < rows && tail < to) { tail += (heights.get(last) ?? estimate) + gap; last++; }
    if (preserved) {
      const row = Math.floor(preserved.index / columns);
      first = Math.max(0, row - Math.ceil((900 + preserved.top) / (estimate + gap)));
      last = Math.min(rows, row + Math.ceil((window.innerHeight + 900 - preserved.top) / (estimate + gap)) + 1);
    }
    start.value = Math.min(count(), first * columns); end.value = Math.min(count(), last * columns);
    top.value = first ? Math.max(0, sum(0, first) + gap * (first - 1)) : 0;
    bottom.value = last < rows ? Math.max(0, sum(last, rows) + gap * (rows - last - 1)) : 0;
    const current = ++revision;
    void nextTick(() => {
      if (current !== revision || !enabled()) return;
      if (!preserved) { anchor = visibleAnchor(); return; }
      const card = root.value?.querySelector<HTMLElement>(`[data-product-index="${preserved.index}"]`);
      if (!card) return;
      const delta = card.getBoundingClientRect().top - preserved.top;
      if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, behavior: 'instant' });
      anchor = visibleAnchor();
      if (restoring > 0 && --restoring > 0) queue();
    });
  }
  function queue() { if (!frame) frame = requestAnimationFrame(measure); }
  function schedule() { if (!enabled() || near) queue(); }
  onMounted(() => {
    window.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', queue, { passive: true });
    observer = new ResizeObserver(queue); if (root.value) observer.observe(root.value);
    visibility = new IntersectionObserver(entries => { near = entries.some(entry => entry.isIntersecting); queue(); }, { rootMargin: '900px 0px' });
    if (root.value) visibility.observe(root.value); queue();
  });
  onBeforeUnmount(() => { revision++; observer?.disconnect(); visibility?.disconnect(); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', queue); cancelAnimationFrame(frame); });
  watch([count, enabled], () => { if (!enabled()) reset(); if (import.meta.client) queue(); }, { flush: 'post' });
  onUpdated(() => { if (enabled()) schedule(); });
  return { start, end, top, bottom };
}
