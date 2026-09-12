<template>
  <div class="order-progress">
    <UAlert
      v-if="progress.canceled"
      color="error"
      variant="soft"
      icon="i-lucide-circle-x"
      title="Заказ отменён"
    />
    <UAlert
      v-else-if="progress.unknown"
      color="neutral"
      variant="soft"
      title="Статус заказа уточняется"
    />
    <ol v-else class="order-progress__steps" aria-label="Этапы заказа">
      <li
        v-for="step in progress.steps"
        :key="step.status"
        class="order-progress__step"
        :class="`order-progress__step--${step.state}`"
        :aria-current="step.state === 'current' ? 'step' : undefined"
      >
        <span class="order-progress__indicator" aria-hidden="true">
          <UIcon
            v-if="step.state === 'completed'"
            name="i-lucide-check"
            class="order-progress__check"
          />
          <span v-else class="order-progress__dot" />
        </span>
        <span class="order-progress__label"
          >{{ step.label
          }}<span class="sr-only"> — {{ descriptions[step.state] }}</span></span
        >
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
import type { OrderStatus, OrderType } from "~/types/order";
import { orderProgress } from "~/utils/order-progress";
const props = defineProps<{ status: OrderStatus; type: OrderType }>();
const progress = computed(() => orderProgress(props.status, props.type));
const descriptions = {
  completed: "завершено",
  current: "текущий этап",
  future: "впереди",
};
</script>

<style scoped>
.order-progress {
  margin-block: 1.5rem;
}
.order-progress__steps {
  display: grid;
  margin: 0;
  padding: 1rem;
  list-style: none;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: var(--ui-bg-elevated);
}
.order-progress__step {
  position: relative;
  display: grid;
  grid-template-columns: 1.5rem minmax(0, 1fr);
  align-items: center;
  gap: 0.75rem;
  min-height: 2.5rem;
  color: var(--ui-text-muted);
}
.order-progress__step:not(:first-child)::before {
  position: absolute;
  content: "";
  width: 2px;
  height: calc(100% - 1.5rem);
  left: calc(0.75rem - 1px);
  bottom: calc(50% + 0.75rem);
  background: var(--progress-connector, var(--ui-border-accented));
  transition: background-color 180ms ease;
}
.order-progress__step--completed,
.order-progress__step--current {
  --progress-connector: var(--ui-primary);
}
.order-progress__indicator {
  position: relative;
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border: 1px solid var(--ui-border-accented);
  border-radius: 50%;
  background: var(--ui-bg);
  transition:
    background-color 180ms ease,
    border-color 180ms ease,
    box-shadow 180ms ease;
}
.order-progress__dot {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  background: currentColor;
}
.order-progress__step--completed .order-progress__indicator {
  background: var(--ui-primary);
  border-color: var(--ui-primary);
  color: var(--ui-text-inverted);
}
.order-progress__step--current .order-progress__indicator {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--ui-primary) 14%, transparent);
}
.order-progress__step--completed,
.order-progress__step--current {
  color: var(--ui-text);
}
.order-progress__check {
  width: 0.875rem;
  height: 0.875rem;
}
.order-progress__label {
  font-size: 0.8125rem;
  line-height: 1.4;
  overflow-wrap: anywhere;
  transition: color 180ms ease;
}
.order-progress__step--current .order-progress__label {
  font-weight: 600;
}
@media (min-width: 40rem) {
  .order-progress__steps {
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    padding: 1.5rem 0.5rem;
  }
  .order-progress__step {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 1.5rem minmax(2.5rem, auto);
    align-items: start;
    justify-items: center;
    gap: 0.75rem;
    text-align: center;
  }
  .order-progress__step:not(:first-child)::before {
    width: calc(100% - 1.5rem);
    height: 2px;
    left: calc(-50% + 0.75rem);
    top: calc(0.75rem - 1px);
    bottom: auto;
  }
  .order-progress__label {
    padding-inline: 0.25rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .order-progress__indicator,
  .order-progress__label,
  .order-progress__step::before {
    transition: none;
  }
}
</style>
