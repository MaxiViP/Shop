// One request at a time; suspended in background tabs, cleaned up with its component.
export function useOrderPolling(refresh: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  const tick = async () => {
    try {
      if (active && document.visibilityState === "visible") await refresh();
    } finally {
      if (active) timer = setTimeout(tick, 4000);
    }
  };
  onMounted(() => {
    active = true;
    timer = setTimeout(tick, 4000);
  });
  onBeforeUnmount(() => {
    active = false;
    clearTimeout(timer);
  });
}
