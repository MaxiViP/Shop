import { ref } from "vue";

export type NoticeTarget = "cart" | "favorites";
export interface HeaderNotice {
  target: NoticeTarget;
  text: string;
  id: number;
}
export const NOTICE_DURATION = 2200;

export function createHeaderNotice() {
  const current = ref<HeaderNotice | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;

  function clear() {
    clearTimeout(timer);
    timer = undefined;
    current.value = null;
  }

  function show(notice: Pick<HeaderNotice, "target" | "text">) {
    clearTimeout(timer);
    current.value = { ...notice, id: ++revision };
    timer = setTimeout(clear, NOTICE_DURATION);
  }

  return { current, show, clear };
}
