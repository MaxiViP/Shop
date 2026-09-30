<template>
  <section class="phones">
    <header class="phones__head">
      <h2 class="phones__title">Телефоны для заказов</h2>
      <p class="phones__hint">Дополнительные номера используются только для связи по заказам, не для входа.</p>
    </header>

    <p v-if="error" class="phones__error" role="alert">{{ error }}</p>
    <p v-if="!snapshot" class="phones__hint" role="status">Загружаем номера…</p>
    <div v-else class="phones__list">
      <div v-for="item in snapshot.phones" :key="item.id ?? item.source" class="phones__item">
        <div class="phones__details">
          <strong>{{ item.phone }}</strong>
          <small>{{ sourceLabel(item.source) }}</small>
          <small v-if="item.manualId">Также добавлен вручную</small>
          <span v-if="item.phone === snapshot.primaryPhone" class="phones__primary">Основной</span>
        </div>
        <div class="phones__actions">
          <UButton
            v-if="item.phone !== snapshot.primaryPhone"
            type="button"
            variant="soft"
            color="neutral"
            :disabled="busy"
            @click="setPrimary(item.phone)"
          >Сделать основным</UButton>
          <UButton
            v-if="item.source === 'MANUAL' || item.manualId"
            type="button"
            variant="ghost"
            color="neutral"
            :disabled="busy"
            :aria-label="'Изменить ' + item.phone"
            @click="startEdit(item)"
          >Изменить</UButton>
          <UButton
            v-if="item.source === 'MANUAL' || item.manualId"
            type="button"
            variant="ghost"
            color="error"
            :disabled="busy"
            :aria-label="'Удалить ' + item.phone"
            @click="remove(item)"
          >Удалить</UButton>
        </div>
      </div>
      <p v-if="!snapshot.phones.length" class="phones__hint">Пока нет номера для заказов.</p>
    </div>

    <form v-if="snapshot && (editingId !== null || manualCount < 5)" class="phones__form" @submit.prevent="save">
      <UFormField :label="editingId === null ? 'Дополнительный телефон' : 'Изменить телефон'" :error="inputError">
        <AppTextInput
          v-model="draft"
          format="phone"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          placeholder="+7 (___) ___-__-__"
          :aria-invalid="Boolean(inputError)"
        />
      </UFormField>
      <div class="phones__actions">
        <UButton type="submit" :loading="busy">{{ editingId === null ? 'Добавить номер' : 'Сохранить' }}</UButton>
        <UButton v-if="editingId !== null" type="button" variant="ghost" color="neutral" :disabled="busy" @click="cancelEdit">Отмена</UButton>
      </div>
    </form>
    <p v-if="manualCount >= 5 && editingId === null" class="phones__hint">Добавлено пять дополнительных номеров — это максимум.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { OrderPhone, OrderPhoneSnapshot } from "~/types/order-phone";

const props = defineProps<{ snapshot: OrderPhoneSnapshot | null }>();
const emit = defineEmits<{ changed: [value: OrderPhoneSnapshot] }>();
const api = useApiClient();
const draft = ref("");
const editingId = ref<number | null>(null);
const busy = ref(false);
const error = ref("");
const inputError = ref("");
const manualCount = computed(() => props.snapshot?.manualCount ?? 0);

function sourceLabel(source: OrderPhone["source"]) {
  if (source === "ACCOUNT") return "Телефон аккаунта";
  if (source === "TELEGRAM") return "Подтверждённый Telegram";
  return "Добавлен вручную · не подтверждён";
}

function startEdit(item: OrderPhone) {
  editingId.value = item.manualId ?? item.id;
  draft.value = item.phone;
  error.value = "";
  inputError.value = "";
}

function cancelEdit() {
  editingId.value = null;
  draft.value = "";
  inputError.value = "";
}

async function mutate(path: string, method: "POST" | "PATCH" | "DELETE", body?: { phone: string }) {
  busy.value = true;
  error.value = "";
  try {
    const value = await api<OrderPhoneSnapshot>(path, { method, ...(body ? { body } : {}) });
    emit("changed", value);
    return true;
  } catch {
    error.value = "Не удалось сохранить номер. Проверьте формат и отсутствие дубликатов.";
    return false;
  } finally {
    busy.value = false;
  }
}

async function save() {
  inputError.value = /^\+7\d{10}$/.test(draft.value.replace(/[\s()-]/g, ""))
    ? "" : "Введите корректный номер телефона";
  if (inputError.value) return;
  const id = editingId.value;
  const success = await mutate(id === null ? "/order-phones" : `/order-phones/${id}`, id === null ? "POST" : "PATCH", { phone: draft.value });
  if (success) cancelEdit();
}

async function remove(item: OrderPhone) {
  const id = item.manualId ?? item.id;
  if (id === null) return;
  if (await mutate(`/order-phones/${id}`, "DELETE") && editingId.value === id)
    cancelEdit();
}

async function setPrimary(value: string) {
  await mutate("/order-phones/primary", "PATCH", { phone: value });
}
</script>

<style scoped>
.phones {
  margin-top: var(--section-gap);
}
.phones__head,
.phones__details,
.phones__list,
.phones__form {
  display: grid;
  gap: 0.5rem;
}
.phones__title {
  font-size: var(--section-title);
  font-weight: 700;
}
.phones__hint,
.phones__details small {
  color: var(--ui-text-muted);
}
.phones__error {
  margin-top: 1rem;
  color: var(--ui-error);
}
.phones__list {
  margin-top: 1rem;
}
.phones__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}
.phones__primary {
  color: var(--ui-primary);
  font-size: 0.875rem;
}
.phones__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.phones__form {
  margin-top: 1rem;
  max-width: 30rem;
}
.phones :deep(button) {
  min-height: var(--touch-target);
}
</style>
