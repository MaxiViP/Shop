<template>
  <UCard class="issue">
    <div class="issue__heading">
      <h3 class="font-semibold">{{ issue.orderItem.productName }}</h3>
      <UBadge
        :color="issue.status === 'RESOLVED' ? 'success' : 'warning'"
        variant="soft"
        >{{ statusText }}</UBadge
      >
    </div>
    <template v-if="issue.type === 'WEIGHT_DEVIATION'">
      <p>
        Заказано: {{ qtyText("GRAM", issue.requestedQty) }} · Допуск: ±{{
          bpsPercent(bps)
        }}%
      </p>
      <p>
        Собрано: {{ qtyText("GRAM", issue.actualQty ?? 0) }} · Отклонение:
        {{ deviation }}%
      </p>
      <p v-if="issue.actualQty">
        Стоимость:
        {{
          money(
            lineAmount(
              issue.orderItem.price,
              issue.actualQty,
              issue.orderItem.priceQty,
            ),
          )
        }}
      </p>
    </template>
    <p v-else>Исходного товара нет в наличии. Он останется в истории заказа.</p>
    <div
      v-if="issue.type === 'REPLACEMENT' && issue.proposedName"
      class="issue__proposal"
    >
      <img
        v-if="issue.proposedImageUrl"
        :src="asset(issue.proposedImageUrl)"
        :alt="issue.proposedName"
        class="issue__image"
        loading="lazy"
      >
      <div>
        <p class="font-semibold">Предлагаем замену: {{ issue.proposedName }}</p>
        <p v-if="issue.proposedUnit && issue.proposedQty">
          {{ qtyText(issue.proposedUnit, issue.proposedQty) }}
        </p>
        <p
          v-if="
            issue.proposedPrice && issue.proposedPriceQty && issue.proposedQty
          "
        >
          {{
            money(
              lineAmount(
                issue.proposedPrice,
                issue.proposedQty,
                issue.proposedPriceQty,
              ),
            )
          }}
        </p>
      </div>
    </div>
    <div
      v-if="!staff && issue.status === 'WAITING_CUSTOMER' && assembling"
      class="issue__actions"
    >
      <UButton
        v-if="issue.type === 'WEIGHT_DEVIATION'"
        :disabled="busy"
        @click="decide('ACCEPT_ACTUAL')"
        >Согласен на {{ qtyText("GRAM", issue.actualQty ?? 0) }}</UButton
      >
      <UButton
        v-if="issue.type === 'WEIGHT_DEVIATION'"
        variant="outline"
        :disabled="busy"
        @click="decide('REQUEST_REDUCE')"
        >Попросить уменьшить</UButton
      >
      <UButton
        v-if="issue.type === 'REPLACEMENT'"
        :disabled="busy"
        @click="decide('ACCEPT_REPLACEMENT')"
        >Заменить</UButton
      >
      <UButton variant="outline" :disabled="busy" @click="decide('REMOVE_ITEM')"
        >Убрать товар</UButton
      >
      <UButton
        color="error"
        variant="ghost"
        :disabled="busy"
        @click="cancelOpen = true"
        >Отменить заказ</UButton
      >
    </div>
    <p v-if="staff && issue.status === 'WAITING_SELLER'" class="text-warning">
      Покупатель попросил уменьшить вес. Верните позицию в сборку и
      скорректируйте её.
    </p>
    <div
      v-if="
        staff &&
        assembling &&
        ['MISSING_ITEM', 'REPLACEMENT'].includes(issue.type) &&
        issue.status === 'WAITING_CUSTOMER'
      "
      class="issue__replacement"
    >
      <UFormField label="Найти замену в каталоге"
        ><UInput v-model="search" placeholder="Название товара"
      /></UFormField>
      <UButton variant="outline" :loading="searching" @click="find"
        >Найти</UButton
      >
      <p v-if="searched && !products.length" class="text-muted">
        Товары не найдены
      </p>
      <UFormField v-if="products.length" label="Товар"
        ><USelect
          v-model="productId"
          :items="products.map((p) => ({ label: p.name, value: p.id }))"
      /></UFormField>
      <UFormField v-if="productId" label="Количество (г для весового товара)"
        ><UInput v-model.number="qty" type="number" min="1" step="1"
      /></UFormField>
      <UButton v-if="productId" :disabled="busy" @click="propose"
        >Предложить замену</UButton
      >
    </div>
    <template v-if="staff && issue.status === 'WAITING_CUSTOMER' && assembling">
      <p v-if="wait >= responseMinutes" class="text-warning">
        Покупатель не ответил {{ wait }} мин.
      </p>
      <div class="issue__actions">
        <UButton :to="`tel:${phone}`" icon="i-lucide-phone" variant="outline"
          >Позвонить покупателю</UButton
        >
        <UButton
          v-if="smsAvailable"
          :disabled="busy"
          variant="outline"
          @click="sendSms"
          >Отправить SMS повторно</UButton
        >
      </div>
      <p v-if="!smsAvailable" class="text-muted">
        SMS не настроены — при необходимости позвоните покупателю.
      </p>
    </template>
    <UModal
      v-model:open="cancelOpen"
      title="Отменить заказ?"
      description="Все позиции заказа будут отменены. Возврат оплаченного заказа здесь недоступен."
    >
      <template #body
        ><UButton color="error" :loading="busy" @click="decide('CANCEL_ORDER')"
          >Подтвердить отмену</UButton
        ></template
      >
    </UModal>
  </UCard>
</template>

<script setup lang="ts">
import type { OrderIssue } from "~/types/coordination";
const props = defineProps<{
  issue: OrderIssue;
  base: string;
  bps: number;
  staff: boolean;
  phone?: string;
  smsAvailable: boolean;
  responseMinutes: number;
  now: number;
  assembling: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
const api = useApiClient();
const asset = useAsset();
const toast = useToast();
const busy = ref(false);
const cancelOpen = ref(false);
const search = ref("");
const searching = ref(false);
const searched = ref(false);
const products = ref<{ id: number; name: string; min: number }[]>([]);
const productId = ref<number>();
const qty = ref(1);
watch(productId, (id) => {
  qty.value = products.value.find((p) => p.id === id)?.min ?? 1;
});
const wait = computed(() => orderWaitMinutes(props.issue.updatedAt, props.now));
const statusText = computed(
  () =>
    ({
      WAITING_CUSTOMER: "Нужен ответ покупателя",
      WAITING_SELLER: "Нужен ответ продавца",
      RESOLVED: "Решено",
      CANCELED: "Отменено",
    })[props.issue.status],
);
const deviation = computed(() =>
  (
    (((props.issue.actualQty ?? props.issue.requestedQty) -
      props.issue.requestedQty) *
      100) /
    props.issue.requestedQty
  ).toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
    signDisplay: "always",
  }),
);
async function mutate(path: string, body: object) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(`${props.base}/issues/${props.issue.id}/${path}`, {
      method: "POST",
      body,
    });
    cancelOpen.value = false;
    emit("refresh");
  } catch (error) {
    toast.add({ title: apiError(error), color: "error" });
    emit("refresh");
  } finally {
    busy.value = false;
  }
}
function decide(action: string) {
  return mutate("decision", { version: props.issue.version, action });
}
function propose() {
  return mutate("proposal", {
    version: props.issue.version,
    productId: productId.value,
    qty: qty.value,
  });
}
function sendSms() {
  return mutate("sms", {});
}
async function find() {
  if (searching.value) return;
  searching.value = true;
  try {
    products.value = (
      await api<{ items: typeof products.value }>("/products", {
        query: { q: search.value.trim(), limit: 20 },
      })
    ).items;
    searched.value = true;
    productId.value = undefined;
  } catch (error) {
    toast.add({ title: apiError(error), color: "error" });
  } finally {
    searching.value = false;
  }
}
</script>

<style scoped>
.issue {
  min-width: 0;
}
.issue__heading,
.issue__actions,
.issue__proposal {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  margin-block: 0.75rem;
}
.issue__replacement {
  display: grid;
  gap: 0.75rem;
  margin-block: 1rem;
}
.issue__actions :deep(button),
.issue__actions :deep(a) {
  min-height: 44px;
}
.issue__image {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 0.5rem;
}
</style>
