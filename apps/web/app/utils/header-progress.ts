import { ref } from "vue";

// Two frames let the reset width be painted before starting the transition.
export function createHeaderProgress(
  schedule: (callback: () => void) => number = (callback) =>
    requestAnimationFrame(callback),
  cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
) {
  const running = ref(false);
  let frame: number | undefined;

  function reset() {
    if (frame !== undefined) cancel(frame);
    frame = undefined;
    running.value = false;
  }

  function start() {
    reset();
    frame = schedule(() => {
      frame = schedule(() => {
        frame = undefined;
        running.value = true;
      });
    });
  }

  return { running, start, reset };
}
