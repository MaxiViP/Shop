<template>
  <UCard
    v-if="
      order.assemblyFinalizedAt &&
      payment &&
      order.status !== 'CANCELED' &&
      payment.status !== 'CANCELED'
    "
    class="payment"
  >
    <template #header
      ><h2 class="text-xl font-semibold">Оплата заказа</h2></template
    >
    <div class="payment__body">
      <p class="text-2xl font-semibold">
        {{ payment.status === "PAID" ? "Оплачено" : "К оплате" }}:
        {{ money(payment.amount) }}
      </p>
      <p v-if="order.type === 'DELIVERY'" class="text-muted">
        Доставка оплачивается отдельно.
      </p>
      <UAlert
        v-if="payment.status === 'REPORTED'"
        color="info"
        title="Вы сообщили об оплате"
        description="Продавец проверит поступление перевода. Повторно переводить деньги не нужно."
      />
      <UAlert
        v-else-if="payment.status === 'PAID'"
        color="success"
        title="Оплата получена"
        :description="
          order.type === 'DELIVERY'
            ? 'Оформляем доставку.'
            : 'Заказ готовится к выдаче.'
        "
      />
      <template v-else-if="details?.methods.length">
        <div class="payment__methods" aria-label="Способ оплаты">
          <UButton
            v-for="method in details.methods"
            :key="method"
            :variant="selected === method ? 'solid' : 'outline'"
            :aria-pressed="selected === method"
            @click="selected = method"
            >{{ paymentMethods[method] }}</UButton
          >
        </div>
        <p v-if="details.recipientName">
          Получатель: {{ details.recipientName }}
        </p>
        <p v-if="details.bankName">Банк: {{ details.bankName }}</p>
        <template v-if="selected === 'SBP'">
          <p v-if="details.phone">Телефон: {{ details.phone }}</p>
          <UButton
            v-if="details.phone"
            variant="outline"
            @click="copy(details.phone)"
            >Скопировать телефон</UButton
          >
          <UButton
            v-if="details.sbpLink"
            :to="details.sbpLink"
            target="_blank"
            rel="noopener noreferrer"
            >Открыть СБП</UButton
          >
        </template>
        <template v-if="selected === 'CARD_TRANSFER' && details.cardNumber">
          <p>Карта: {{ details.cardNumber }}</p>
          <UButton variant="outline" @click="copy(details.cardNumber)"
            >Скопировать карту</UButton
          >
        </template>
        <template v-if="selected === 'QR' && details.qrImageUrl">
          <img
            class="payment__qr"
            :src="details.qrImageUrl"
            alt="QR-код для оплаты товаров"
            @error="qrError = true"
          >
          <UAlert
            v-if="qrError"
            color="warning"
            title="QR не загрузился. Выберите другой способ или свяжитесь с продавцом."
          />
          <p class="text-muted">
            Укажите точную сумму {{ money(payment.amount) }}. QR не содержит
            автоматически рассчитанную сумму заказа.
          </p>
        </template>
        <UButton
          variant="outline"
          @click="copy(kopecksToRubles(payment.amount))"
          >Скопировать сумму</UButton
        >
        <p class="text-muted">
          Переведите точную сумму по указанным реквизитам. После перевода ничего
          подтверждать не нужно.
          {{
            order.type === "DELIVERY"
              ? "Продавец проверит поступление средств и оформит доставку."
              : "Продавец проверит поступление оплаты."
          }}
        </p>
      </template>
      <UAlert
        v-else
        color="warning"
        title="Реквизиты пока не настроены"
        description="Свяжитесь с продавцом. Не переводите деньги по неизвестным реквизитам."
      />
      <p>
        Есть вопрос по сумме?
        <a href="#order-chat" class="text-primary underline"
          >Написать продавцу</a
        >
      </p>
    </div>
  </UCard>
</template>

<script setup lang="ts">
import type { OrderDetail, PaymentMethod } from "~/types/order";
const props = defineProps<{ order: OrderDetail }>();
const payment = computed(() => props.order.payment);
const details = computed(() => props.order.paymentDetails);
const selected = ref<PaymentMethod>();
watch(
  details,
  (value) => {
    if (!selected.value || !value?.methods.includes(selected.value))
      selected.value = value?.methods[0];
  },
  { immediate: true },
);
const toast = useToast();
const qrError = ref(false);
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.add({ title: "Скопировано" });
  } catch {
    toast.add({
      title: "Не удалось скопировать. Выделите значение вручную.",
      color: "error",
    });
  }
}
</script>

<style scoped>
.payment {
  margin-block: 1.5rem;
}
.payment__body {
  display: grid;
  gap: 1rem;
  justify-items: start;
  overflow-wrap: anywhere;
}
.payment__methods {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.payment__qr {
  width: min(100%, 16rem);
  height: auto;
}
.payment :deep(button) {
  min-height: 44px;
}
</style>
