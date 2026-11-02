export function useHeaderOffset() {
  const offset = ref(64);
  let frame = 0;
  let header: HTMLElement | null = null;
  let observer: MutationObserver | undefined;
  let resizeObserver: ResizeObserver | undefined;

  function measure() {
    frame = 0;
    offset.value = Math.max(0, header?.getBoundingClientRect().bottom ?? 0);
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure);
  }

  onMounted(() => {
    header = document.querySelector<HTMLElement>('header.header');
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    if (header) {
      observer = new MutationObserver(schedule);
      observer.observe(header, { attributes: true, attributeFilter: ['class'] });
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(header);
      header.addEventListener('transitionend', schedule);
    }
    measure();
  });
  onBeforeUnmount(() => {
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    header?.removeEventListener('transitionend', schedule);
    observer?.disconnect();
    resizeObserver?.disconnect();
    cancelAnimationFrame(frame);
  });
  return offset;
}
