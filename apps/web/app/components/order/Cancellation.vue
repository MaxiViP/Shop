<template>
  <section class="cancellation" aria-label="Отмена и восстановление заказа">
    <details
      v-if="order.cancellations.length"
      :open="order.status === 'CANCELED'"
    >
      <summary class="cancellation__summary">
        История отмен и восстановлений
      </summary>
      <article
        v-for="entry in order.cancellations"
        :key="entry.id"
        class="cancellation__entry"
      >
        <p>
          Отменён {{ date(entry.canceledAt) }} · {{ roles[entry.canceledByRole]
          }}<span v-if="entry.canceledBy?.name">
            · {{ entry.canceledBy.name }}</span
          >
        </p>
        <p>
          Было состояние: {{ orderMeta(entry.fromStatus, order.type).label }}
        </p>
        <p v-if="entry.reason">Причина (для сотрудников): {{ entry.reason }}</p>
        <p v-if="entry.restoredAt">
          Восстановлен {{ date(entry.restoredAt) }} ·
          {{ entry.restoredByRole ? roles[entry.restoredByRole] : "Сотрудник"
          }}<span v-if="entry.restoredBy?.name">
            · {{ entry.restoredBy.name }}</span
          >
        </p>
      </article>
    </details>
    <UButton
      v-if="canCancel"
      color="error"
      variant="soft"
      :disabled="disabled"
      @click="openCancel"
      >Отменить заказ</UButton
    >
    <template v-if="order.status === 'CANCELED'">
      <UButton :to="`/staff/orders/${order.id}`" variant="ghost"
        >Открыть заказ</UButton
      >
      <p v-if="order.restoreProblem" class="text-muted">
        {{ order.restoreProblem }}
      </p>
      <template v-else>
        <p class="text-muted">
          Заказ вернётся в состояние «{{ previousLabel }}».
        </p>
        <UButton :disabled="disabled" variant="outline" @click="openRestore"
          >Восстановить заказ</UButton
        >
      </template>
    </template>
    <UModal
      v-model:open="open"
      :title="
        restoring
          ? `Восстановить заказ №${order.id}?`
          : `Отменить заказ №${order.id}?`
      "
      :description="
        restoring
          ? `Заказ вернётся в состояние «${previousLabel}». Данные сборки сохранятся.`
          : 'Заказ будет перемещён в раздел «Отменённые».'
      "
      :dismissible="!busy"
    >
      <template #body>
        <form class="cancellation__form" @submit.prevent="save">
          <UFormField
            v-if="!restoring"
            label="Причина отмены"
            description="Необязательно. Видна только сотрудникам."
          >
            <UTextarea
              v-model="reason"
              class="w-full"
              :maxlength="1000"
              :disabled="busy"
            />
          </UFormField>
          <UAlert v-if="error" color="error" :title="error" />
          <div class="cancellation__actions">
            <UButton variant="ghost" :disabled="busy" @click="open = false"
              >Назад</UButton
            >
            <UButton
              type="submit"
              :color="restoring ? 'primary' : 'error'"
              :loading="busy"
              >{{
                restoring ? "Восстановить заказ" : "Отменить заказ"
              }}</UButton
            >
          </div>
        </form>
      </template>
    </UModal>
  </section>
</template>
<script setup lang="ts">
import type { StaffOrder, StaffOrderDetail } from "~/types/order";
const props = defineProps<{
  order: StaffOrder | StaffOrderDetail;
  disabled?: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
const api = useApiClient();
const revision = useNewOrdersRevision();
const communication = useCommunicationRevision();
const open = ref(false);
const restoring = ref(false);
const busy = ref(false);
const reason = ref("");
const error = ref("");
let cancellationId: number | undefined;
const roles = {
  USER: "Покупатель",
  SELLER: "Продавец",
  ADMIN: "Администратор",
};
const previousLabel = computed(() => {
  const previous = props.order.cancellations[0];
  return previous
    ? orderMeta(previous.fromStatus, props.order.type).label
    : "—";
});
const canCancel = computed(
  () =>
    ["NEW", "CONFIRMED", "ASSEMBLING", "READY"].includes(props.order.status) &&
    !["PAID", "REPORTED"].includes(props.order.payment?.status ?? "") &&
    !props.order.delivery?.externalOrderId &&
    props.order.delivery?.provider !== "OTHER" &&
    (!props.order.delivery ||
      ["PENDING", "ASSIGNED", "CANCELED"].includes(
        props.order.delivery.status,
      )),
);
const date = (value: string) =>
  new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) +
  " МСК";
function openCancel() {
  restoring.value = false;
  reason.value = "";
  error.value = "";
  open.value = true;
}
function openRestore() {
  restoring.value = true;
  cancellationId = props.order.cancellations[0]?.id;
  error.value = "";
  open.value = true;
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/staff/orders/${props.order.id}/${restoring.value ? "restore" : "cancel"}`,
      {
        method: "POST",
        body: restoring.value
          ? { cancellationId }
          : { reason: reason.value.trim() },
      },
    );
    revision.value++;
    communication.value++;
    open.value = false;
    emit("refresh");
  } catch (cause) {
    error.value = apiError(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<style scoped>
.cancellation {
  display: grid;
  gap: 0.75rem;
  justify-items: start;
  min-width: 0;
}
.cancellation__summary {
  cursor: pointer;
  min-height: 44px;
  padding-block: 0.75rem;
}
.cancellation__entry {
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
  overflow-wrap: anywhere;
}
.cancellation__form {
  display: grid;
  gap: 1rem;
}
.cancellation__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: end;
  gap: 0.5rem;
}
.cancellation :deep(button),
.cancellation__actions :deep(button) {
  min-height: 44px;
}
</style>
