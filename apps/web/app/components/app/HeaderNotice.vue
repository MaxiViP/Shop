<template>
  <div
    class="header-notice"
    :class="{ 'header-notice--floating': floating }"
    :style="{ '--notice-start': startWidth, '--notice-remaining': remaining }"
  >
    <Transition name="header-notice">
      <div v-if="notice" class="header-notice__panel" aria-hidden="true">
        <p class="header-notice__text">{{ notice.text }}</p>
        <div class="header-notice__progress">
          <span
            :key="notice.id"
            class="header-notice__progress-fill"
            :class="{ 'header-notice__progress-fill--run': running }"
          />
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { NOTICE_DURATION, type NoticeTarget } from "~/utils/header-notice";
import { createHeaderProgress } from "~/utils/header-progress";
const props = defineProps<{ target: NoticeTarget; floating?: boolean }>();
const state = useHeaderNotice();
const notice = computed(() =>
  state.current?.target === props.target ? state.current : null,
);
const startWidth = ref("0%");
const remaining = ref(`${NOTICE_DURATION}ms`);
const { running, start, reset } = createHeaderProgress();
watch(
  () => notice.value?.id,
  (id) => {
    const active = notice.value;
    if (id !== undefined && active) {
      const elapsed = Math.min(
        NOTICE_DURATION,
        Math.max(0, Date.now() - active.shownAt),
      );
      startWidth.value = `${(elapsed / NOTICE_DURATION) * 100}%`;
      remaining.value = `${NOTICE_DURATION - elapsed}ms`;
      start();
    } else reset();
  },
  { flush: "pre", immediate: true },
);
onBeforeUnmount(reset);
</script>

<style scoped>
.header-notice {
  position: absolute;
  top: calc(100% + 0.75rem);
  right: calc(50% - 1rem);
  width: min(12rem, calc(100vw - 5rem));
  pointer-events: none;
  z-index: 1;
}
.header-notice--floating {
  width: min(
    12rem,
    calc(
      100vw - max(0.5rem, env(safe-area-inset-left, 0px)) -
        max(0.5rem, env(safe-area-inset-right, 0px)) - 50% + 1rem
    )
  );
}
.header-notice__panel {
  position: relative;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
  background: var(--ui-bg);
  color: var(--ui-text);
  box-shadow: 0 4px 16px #0002;
}
.header-notice__panel::after {
  content: "";
  position: absolute;
  top: -0.3125rem;
  right: 1rem;
  width: 0.5rem;
  height: 0.5rem;
  transform: translateX(50%) rotate(45deg);
  background: var(--ui-bg);
  border-top: 1px solid var(--ui-border);
  border-left: 1px solid var(--ui-border);
}
.header-notice__text {
  font-size: 0.8125rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.header-notice__progress {
  width: 100%;
  height: 3px;
  margin-top: 0.5rem;
  overflow: hidden;
  border-radius: 1rem;
  background: var(--ui-bg-accented);
}
.header-notice__progress-fill {
  display: block;
  width: var(--notice-start);
  height: 100%;
  background: var(--ui-primary);
  transition: none;
}
.header-notice__progress-fill--run {
  width: 100%;
  transition: width var(--notice-remaining) linear;
}
.header-notice-enter-active,
.header-notice-leave-active {
  transition: opacity 150ms ease;
}
.header-notice-enter-from,
.header-notice-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .header-notice__progress-fill--run {
    /* Elapsed-time indicator, not decorative motion: override main.css's
       universal 0.01ms !important reset only for this timer fill. */
    transition-duration: var(--notice-remaining) !important;
  }
  .header-notice-enter-active,
  .header-notice-leave-active {
    transition: none;
  }
}
</style>
