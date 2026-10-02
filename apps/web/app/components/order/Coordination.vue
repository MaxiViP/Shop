<template>
  <section class="coordination" aria-label="Согласование заказа">
    <h2 class="text-xl font-semibold">Согласование заказа</h2>
    <div class="coordination__intro">
      <p>Продавец может прямо с рынка отправить фото прилавка с доступными продуктами. Вы сможете открыть снимок, отметить нужный товар прямо на фото и отправить его обратно продавцу.</p>
      <p class="coordination__aside">Почти как выбрать продукт лично на рынке — только не выходя из дома.</p>
    </div>
    <UAlert v-if="error" color="error" title="Не удалось загрузить согласование"
      ><template #actions
        ><UButton @click="reload">Повторить</UButton></template
      ></UAlert
    >
    <p v-if="pending && !data">Загрузка…</p>
    <template v-if="data">
      <p v-if="required" role="status" class="text-warning font-semibold">
        {{
          staff ? "Есть нерешённые вопросы по заказу" : "Требуется ваше решение"
        }}
      </p>
      <OrderIssue
        v-for="issue in data.issues"
        :key="issue.id"
        :issue="issue"
        :base="base"
        :bps="bps"
        :staff="staff"
        :phone="phone"
        :sms-available="data.smsAvailable"
        :response-minutes="data.responseMinutes"
        :now="now"
        :assembling="assembling"
        @refresh="changed"
      />
      <p
        v-if="
          staff &&
          data.notifications.some(
            (event) =>
              event.status === 'FAILED' ||
              event.status === 'UNCONFIGURED' ||
              event.status === 'SENDING',
          )
        "
        class="text-muted"
      >
        Не все SMS доставлены или отправка не подтверждена. Проверьте связь с
        покупателем по телефону.
      </p>
      <OrderChat
        :base="base"
        :staff="staff"
        :poll="poll"
        :unread="data.unread"
        :read-through="data.readThrough"
        :status="data.status"
        :issues="data.issues"
        @read="reload"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import type { Coordination } from "~/types/coordination";
const props = withDefaults(
  defineProps<{
    base: string;
    bps: number;
    staff?: boolean;
    phone?: string;
    assembling: boolean;
    poll?: boolean;
  }>(),
  { staff: false, phone: undefined },
);
const emit = defineEmits<{ refresh: [] }>();
const { data, pending, error, refresh } = await useApi<Coordination>(
  `${props.base}/coordination`,
);
const now = ref(0);
const required = computed(() =>
  data.value?.issues.some((issue) =>
    props.staff
      ? ["WAITING_CUSTOMER", "WAITING_SELLER"].includes(issue.status)
      : issue.status === "WAITING_CUSTOMER",
  ),
);
let busy = false;
let active = true;
const signature = () =>
  JSON.stringify(
    data.value?.issues.map((issue) => [
      issue.id,
      issue.version,
      issue.status,
      issue.resolution,
    ]),
  );
async function reload() {
  if (busy || !active) return;
  busy = true;
  const before = signature();
  try {
    await refresh();
    if (active) {
      now.value = Date.now();
      if (signature() !== before) emit("refresh");
    }
  } finally {
    busy = false;
  }
}
async function changed() {
  await reload();
  emit("refresh");
}
onMounted(() => {
  now.value = Date.now();
});
onBeforeUnmount(() => {
  active = false;
});
useOrderPolling(reload, () => props.poll === false ? 30000 : 4000);
</script>

<style scoped>
.coordination {
  display: grid;
  gap: 1rem;
  margin-block: 1.5rem;
  min-width: 0;
  padding: var(--card-padding);
  border: 2px solid color-mix(in srgb, var(--ui-primary) 55%, var(--ui-border));
  border-radius: 1.25rem;
  background: color-mix(in srgb, var(--ui-primary) 7%, var(--ui-bg));
  box-shadow: 0 14px 36px rgb(0 0 0 / 12%);
}
.coordination__intro { display: grid; gap: 0.35rem; max-width: 68ch; line-height: 1.55; }
.coordination__aside { color: var(--ui-text-muted); font-size: 0.875rem; }
</style>
