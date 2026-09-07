import { defineStore } from "pinia";
import { createHeaderNotice } from "~/utils/header-notice";

// One app-scoped notice, independent of cart/favorites business state.
export const useHeaderNotice = defineStore("header-notice", () => {
  const notice = createHeaderNotice();
  onScopeDispose(notice.clear);
  return notice;
});
