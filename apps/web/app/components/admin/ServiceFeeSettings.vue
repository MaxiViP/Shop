<template>
  <UCard class="ring-primary/30">
    <template #header><h3 class="font-semibold">Сервисное вознаграждение</h3></template>
    <form class="space-y-4 max-w-xl" @submit.prevent="requestSave">
      <p role="status">Текущий глобальный процент: <strong>{{ percent }}%</strong></p>
      <p class="text-sm text-muted">Процент включается в стоимость товаров, использующих общую настройку</p>
      <UFormField label="Глобальный процент, %" :error="validation" help="Целое число от 0 до 100%. Начальное значение — 10%." required>
        <UInput v-model="draft" aria-label="Глобальный процент, %" type="number" min="0" max="100" step="1" required :disabled="busy" class="w-full sm:max-w-48" />
      </UFormField>
      <UAlert v-if="error" color="error" :title="error" />
      <UButton type="submit" :loading="busy" :disabled="busy || target === null || target === percent">Сохранить изменения</UButton>
    </form>
    <UModal v-model:open="confirm" title="Изменить общий процент?" :description="`Новый процент ${requested ?? ''}% изменит цены товаров с общей настройкой. Индивидуальные проценты и исторические заказы сохранятся.`" :dismissible="!busy">
      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton color="neutral" variant="outline" :disabled="busy" @click="confirm = false">Отмена</UButton>
          <UButton :loading="busy" @click="save">Подтвердить изменение</UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>

<script setup lang="ts">
import { servicePercent, serviceFeeError } from '~/utils/service-fee';
const props = defineProps<{ percent: number }>();
const emit = defineEmits<{ saved: [] }>();
const draft = ref(String(props.percent));
watch(() => props.percent, (value, previous) => {
  if (servicePercent(draft.value) === previous) draft.value = String(value);
});
const target = computed(() => servicePercent(String(draft.value)));
const validation = computed(() => target.value === null ? 'Укажите целое число от 0 до 100%' : undefined);
const busy = ref(false);
const error = ref('');
const confirm = ref(false);
const requested = ref<number | null>(null);
const api = useApiClient();
const toast = useToast();
function requestSave() {
  if (busy.value || target.value === null || target.value === props.percent) return;
  requested.value = target.value;
  error.value = '';
  confirm.value = true;
}
async function save() {
  if (busy.value || requested.value === null) return;
  busy.value = true;
  error.value = '';
  try {
    await api('/admin/settings', { method: 'PATCH', body: { globalServiceMarkupPercent: requested.value } });
    confirm.value = false;
    emit('saved');
    toast.add({ title: 'Сервисное вознаграждение сохранено', color: 'success' });
  } catch (cause) {
    confirm.value = false;
    error.value = serviceFeeError(cause);
    toast.add({ title: error.value, color: 'error' });
  } finally {
    busy.value = false;
  }
}
</script>
