<template>
  <UCard v-if="payment" class="my-6">
    <template #header
      ><h2 class="text-xl font-semibold">Оплата заказа</h2></template
    >
    <div class="space-y-3">
      <p>
        Финальная стоимость товаров и услуг:
        <strong>{{ money(payment.amount) }}</strong>
      </p>
      <UBadge :color="payment.status === 'PAID' ? 'success' : 'neutral'">{{
        paymentLabels[payment.status]
      }}</UBadge>
      <p v-if="payment.method">Способ: {{ paymentMethods[payment.method] }}</p>
      <p v-if="payment.reportedAt">
        Сообщение об оплате: {{ pickupTime(payment.reportedAt) }} МСК
      </p>
      <p v-if="payment.confirmedAt">
        Подтвердил:
        {{
          payment.confirmedBy?.name ||
          `Сотрудник #${payment.confirmedBy?.id ?? "—"}`
        }}
        · {{ pickupTime(payment.confirmedAt) }} МСК
      </p>
      <UButton v-if="type === 'PICKUP' && ['AWAITING', 'REPORTED'].includes(payment.status)" @click="confirm = true"
        >Оплата получена</UButton
      >
      <UAlert v-if="error" color="error" :title="error" />
    </div>
    <UModal
      v-model:open="confirm"
      title="Деньги действительно поступили?"
      description="Подтвердите, что оплата поступила. Проверьте банк и точную сумму перевода."
      :dismissible="!busy"
    >
      <template #body
        ><div class="flex gap-3">
          <UButton :loading="busy" @click="save">Оплата получена</UButton
          ><UButton variant="ghost" :disabled="busy" @click="confirm = false"
            >Отмена</UButton
          >
        </div></template
      >
    </UModal>
  </UCard>
</template>

<script setup lang="ts">
import type { OrderPayment } from "~/types/order";
const props = defineProps<{ orderId: number; type: 'PICKUP' | 'DELIVERY'; payment: OrderPayment | null }>();
const emit = defineEmits<{ refresh: [] }>();
const api = useApiClient();
const confirm = ref(false);
const busy = ref(false);
const error = ref("");
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/staff/orders/${props.orderId}/payment/confirm`, {
      method: "POST",
    });
    confirm.value = false;
    emit("refresh");
  } catch (cause) {
    error.value = apiError(cause);
  } finally {
    busy.value = false;
  }
}
</script>
