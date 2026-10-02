<template>
  <UCard id="order-chat" class="chat">
    <template #header><h3 class="font-semibold">Чат по заказу</h3></template>
    <UAlert v-if="error" color="error" title="Не удалось обновить чат"
      ><template #actions
        ><UButton variant="outline" @click="load">Повторить</UButton></template
      ></UAlert
    >
    <p v-if="!initialLoaded && loading">Загрузка…</p>
    <div
      ref="viewport"
      class="chat__messages"
      tabindex="0"
      aria-label="Сообщения по заказу"
      @scroll="markVisible"
    >
      <UButton
        v-if="hasOlder"
        variant="ghost"
        :disabled="loadingOlder"
        @click="older"
        >Предыдущие сообщения</UButton
      >
      <p v-if="initialLoaded && !messages.length" class="text-muted">
        Сообщений пока нет. Здесь можно обсудить сборку заказа.
      </p>
      <article
        v-for="entry in messages"
        :key="entry.id"
        class="chat__message"
        :class="{
          'chat__message--system': entry.authorType === 'SYSTEM',
          'chat__message--customer': entry.authorType === 'CUSTOMER',
        }"
      >
        <p class="text-sm text-muted">
          {{ author(entry.authorType) }} ·
          <time
            :datetime="entry.createdAt"
            :title="new Date(entry.createdAt).toLocaleDateString('ru-RU')"
            >{{
              new Date(entry.createdAt).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              })
            }}</time
          >
        </p>
        <p v-if="entry.text" class="chat__text">{{ entry.text }}</p>
        <OrderChatImage v-if="entry.image" :id="entry.id" :base="base" :expired="entry.imageExpired" @mark="markImage($event, entry.issueId)" />
      </article>
    </div>
    <p v-if="unread" role="status" class="text-primary text-sm">
      Непрочитанных сообщений: {{ unread }}
    </p>
    <form class="chat__form" @submit.prevent="send">
      <UFormField label="Сообщение продавцу" class="chat__field">
        <template #label>{{
          staff ? "Сообщение покупателю" : "Сообщение продавцу"
        }}</template>
        <UTextarea
          v-model="text"
          class="w-full"
          :rows="2"
          :maxlength="2000"
          placeholder="Сообщение…"
          :disabled="sending"
          @keydown="onKeydown"
        />
      </UFormField>
      <div class="chat__attachments">
        <input ref="photoInput" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" aria-label="Выбрать фото" @change="selectPhoto">
        <input ref="cameraInput" class="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" capture="environment" aria-label="Снять фото" @change="selectPhoto">
        <UButton type="button" size="sm" variant="soft" color="neutral" icon="i-lucide-image-plus" :disabled="sending || preparing" @click="photoInput?.click()">Фото</UButton>
        <UButton type="button" size="sm" variant="soft" color="neutral" icon="i-lucide-camera" :disabled="sending || preparing" @click="cameraInput?.click()">Камера</UButton>
        <UButton v-if="photo" type="button" size="sm" variant="soft" color="neutral" icon="i-lucide-pencil" :disabled="sending || preparing" @click="markupOpen = true">Разметка</UButton>
      </div>
      <div v-if="photo && preview" class="chat__preview">
        <img :src="preview" alt="Фото перед отправкой" class="chat__preview-image">
        <span class="chat__preview-name">{{ photo.name }}</span>
        <UButton type="button" size="sm" variant="ghost" color="neutral" :disabled="sending" @click="removePhoto">Убрать</UButton>
      </div>
      <label v-if="photo && !(status === 'COMPLETED' && !staff)" class="chat__retention">
        Назначение фото
        <select v-model="photoContext" aria-label="Назначение фото">
          <option value="operational">Обычное фото</option>
          <option value="evidence">Фото проблемы или претензии</option>
          <option v-for="issue in issues" :key="issue.id" :value="String(issue.id)">
            Проблема: {{ issue.orderItem.productName }}
          </option>
        </select>
      </label>
      <p v-if="photo && status === 'COMPLETED' && !staff" class="chat__status">Фото после завершения заказа хранится 90 дней.</p>
      <p v-if="photoError" role="alert" class="chat__error">{{ photoError }}</p>
      <p v-if="sendError" role="alert" class="chat__error">{{ sendError }} Форма сохранена; нажмите «Повторить отправку».</p>
      <div v-if="preparing" role="status" class="chat__preparing">
        <span>Подготавливаем HEIC/HEIF…</span>
        <UButton type="button" size="sm" variant="ghost" color="neutral" @click="cancelPhotoPreparation">Отмена</UButton>
      </div>
      <p v-if="sending && photo" role="status" class="chat__status">Загружаем фото…</p>
      <UButton
        type="submit"
        :loading="sending"
        :disabled="(!text.trim() && !photo) || sending || preparing"
        class="chat__send"
        >{{ sendError ? "Повторить отправку" : "Отправить" }}</UButton
      >
    </form>
    <OrderMarkup v-if="photo || markupSource" v-model:open="markupOpen" v-model:text="text" :file="markupSource ?? photo!" @send="sendMarked" />
  </UCard>
</template>

<script setup lang="ts">
import type { ChatMessage, MessagePage, OrderIssue } from "~/types/coordination";
import {
  createChatHistory,
  mergeMessages,
  receiveMessages,
} from "~/utils/chat-messages";
import { chatPhotoError, chatRequest, isHeicPhoto, prepareChatPhoto } from "~/utils/chat-photo";
const props = defineProps<{
  base: string;
  staff: boolean;
  unread: number;
  readThrough: number;
  status: string;
  issues: OrderIssue[];
  poll?: boolean;
}>();
const emit = defineEmits<{ read: [] }>();
const api = useApiClient();
const toast = useToast();
const route = useRoute();
const communicationRevision = useCommunicationRevision();
const history = reactive(createChatHistory());
const { messages, initialLoaded } = toRefs(history);
const text = ref("");
const photo = ref<File | null>(null);
const photoContext = ref('operational');
const preview = ref("");
const photoInput = ref<HTMLInputElement>();
const cameraInput = ref<HTMLInputElement>();
const markupOpen = ref(false);
const markupSource = ref<File | null>(null);
const requestId = ref("");
const sendError = ref("");
const photoError = ref("");
const loading = ref(false);
const loadingOlder = ref(false);
const sending = ref(false);
const preparing = ref(false);
const error = ref(false);
const hasOlder = ref(false);
const viewport = ref<HTMLElement>();
let active = true;
let inView = false;
let observer: IntersectionObserver | undefined;
let reading = false;
let lastRead = 0;
let photoSelection = 0;
let photoPreparation: AbortController | null = null;
// POST responses must not move the GET cursor past unseen concurrent messages.
function author(type: ChatMessage["authorType"]) {
  if (type === "SYSTEM") return "Система";
  if (type === "CUSTOMER") return "Покупатель";
  return type === "ADMIN" ? "Администратор" : "Продавец";
}
const bottom = () =>
  !viewport.value ||
  viewport.value.scrollHeight -
    viewport.value.scrollTop -
    viewport.value.clientHeight <
    48;
async function markVisible() {
  const through = history.cursor ?? 0;
  if (
    !active ||
    reading ||
    !inView ||
    document.visibilityState !== "visible" ||
    !bottom() ||
    through <= Math.max(lastRead, props.readThrough)
  )
    return;
  reading = true;
  try {
    await api(`${props.base}/messages/read`, {
      method: "POST",
      body: { through },
    });
    if (active) {
      lastRead = through;
      communicationRevision.value++;
      emit("read");
    }
  } catch {
    /* Polling retries; read failure must not interrupt writing a message. */
  } finally {
    reading = false;
  }
}
async function load() {
  if (loading.value || !active) return;
  loading.value = true;
  const wasBottom = bottom();
  try {
    const after = history.cursor;
    const page = await api<MessagePage>(`${props.base}/messages`, {
      query: after ? { after } : {},
    });
    if (!active) return;
    if (!after) hasOlder.value = page.hasMore;
    const changed = receiveMessages(history, page.messages);
    if (page.messages.length && wasBottom && messages.value.length > 500) {
      messages.value = messages.value.slice(-500);
      hasOlder.value = true;
    }
    error.value = false;
    await nextTick();
    if (changed && wasBottom && viewport.value)
      viewport.value.scrollTop = viewport.value.scrollHeight;
    await markVisible();
  } catch {
    if (active) error.value = true;
  } finally {
    loading.value = false;
  }
}
async function older() {
  if (loadingOlder.value) return;
  loadingOlder.value = true;
  const previousHeight = viewport.value?.scrollHeight ?? 0;
  const previousTop = viewport.value?.scrollTop ?? 0;
  try {
    const page = await api<MessagePage>(`${props.base}/messages`, {
      query: { before: messages.value[0]?.id },
    });
    if (!active) return;
    messages.value = mergeMessages(messages.value, page.messages);
    hasOlder.value = page.hasMore;
    await nextTick();
    if (viewport.value)
      viewport.value.scrollTop =
        previousTop + viewport.value.scrollHeight - previousHeight;
  } catch {
    error.value = true;
  } finally {
    loadingOlder.value = false;
  }
}
async function send() {
  if (sending.value || preparing.value || (!text.value.trim() && !photo.value)) return;
  sending.value = true;
  sendError.value = "";
  try {
    if (photo.value && !requestId.value) requestId.value = crypto.randomUUID();
    const issueId = /^\d+$/.test(photoContext.value) ? Number(photoContext.value) : undefined;
    const request = chatRequest(text.value, photo.value, photoContext.value === 'evidence', issueId, requestId.value);
    const entry = await api<ChatMessage>(`${props.base}${request.path}`, {
      method: "POST", body: request.body,
    });
    if (active) {
      text.value = "";
      removePhoto();
      messages.value = mergeMessages(messages.value, [entry]);
      await nextTick();
      if (viewport.value)
        viewport.value.scrollTop = viewport.value.scrollHeight;
    }
  } catch (cause) {
    sendError.value = apiError(cause);
    toast.add({ title: sendError.value, color: "error" });
  } finally {
    sending.value = false;
  }
}
function setPhoto(file: File) {
  const validation = chatPhotoError(file);
  if (validation) {
    photoError.value = validation;
    return false;
  }
  if (preview.value) URL.revokeObjectURL(preview.value);
  photo.value = file;
  requestId.value = "";
  preview.value = URL.createObjectURL(file);
  sendError.value = "";
  photoError.value = "";
  return true;
}
async function selectPhoto(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const selection = ++photoSelection;
  photoPreparation?.abort();
  const controller = new AbortController();
  photoPreparation = controller;
  preparing.value = isHeicPhoto(file);
  photoError.value = "";
  try {
    const ready = await prepareChatPhoto(file, controller.signal);
    if (active && selection === photoSelection && setPhoto(ready))
      photoContext.value = 'operational';
  } catch (cause) {
    if (active && selection === photoSelection)
      photoError.value = cause instanceof Error ? cause.message : "Не удалось подготовить фото.";
  } finally {
    if (selection === photoSelection) {
      photoPreparation = null;
      preparing.value = false;
    }
  }
}
function cancelPhotoPreparation() {
  photoSelection++;
  photoPreparation?.abort();
  photoPreparation = null;
  preparing.value = false;
}
function removePhoto() {
  cancelPhotoPreparation();
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = "";
  photo.value = null;
  requestId.value = "";
  photoContext.value = 'operational';
  markupOpen.value = false;
  photoError.value = "";
}
async function sendMarked(file: File) {
  if (!setPhoto(file)) return;
  markupOpen.value = false;
  markupSource.value = null;
  await send();
}
function markImage(file: File, issueId: number | null) {
  markupSource.value = file;
  photoContext.value = issueId ? String(issueId) : 'operational';
  markupOpen.value = true;
}
async function focusChat() {
  if (route.hash !== '#order-chat') return;
  await nextTick();
  document.getElementById('order-chat')?.scrollIntoView({ block: 'start' });
  if (window.matchMedia('(min-width: 40rem)').matches)
    document.querySelector<HTMLTextAreaElement>('#order-chat textarea')?.focus({ preventScroll: true });
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    inView = entries[0]?.isIntersecting ?? false;
    void markVisible();
  });
  if (viewport.value) observer.observe(viewport.value);
  void load();
  void focusChat();
});
onBeforeUnmount(() => {
  active = false;
  cancelPhotoPreparation();
  observer?.disconnect();
  if (preview.value) URL.revokeObjectURL(preview.value);
});
watch(() => route.hash, () => { void focusChat() });
watch(markupOpen, (open) => { if (!open) markupSource.value = null; });
useOrderPolling(load, () => props.poll === false ? 30000 : 4000);
</script>

<style scoped>
.chat {
  min-width: 0;
  scroll-margin-top: calc(var(--header-height) + 1rem);
  border: 1px solid color-mix(in srgb, var(--ui-primary) 35%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-primary) 4%, var(--ui-bg-elevated));
}
.chat__messages {
  min-width: 0;
  min-height: 8rem;
  max-height: min(24rem, 55dvh);
  overflow-y: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: 0.75rem;
  padding: var(--card-padding);
  border: 1px solid var(--ui-border);
  border-radius: 0.875rem;
  background: var(--ui-bg-muted);
  overscroll-behavior: contain;
}
.chat__messages:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.chat__message {
  justify-self: start;
  max-width: 94%;
  min-width: 0;
  padding: 0.75rem;
  border-radius: 0.75rem;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  color: var(--ui-text);
  overflow-wrap: anywhere;
}
.chat__message--customer {
  justify-self: end;
  border-color: color-mix(in srgb, var(--ui-primary) 30%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg));
}
.chat__message--system {
  justify-self: center;
  max-width: 100%;
  text-align: center;
  color: var(--ui-text-muted);
  background: var(--ui-bg-elevated);
}
.chat__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.chat__message :deep(.chat-image) { margin-top: 0.5rem; }
.chat__form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  align-items: end;
  gap: 0.75rem;
  padding-top: 1rem;
  padding-bottom: env(safe-area-inset-bottom);
}
.chat__attachments { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.chat__preview { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; min-width: 0; padding: 0.75rem; border: 1px solid var(--ui-border); border-radius: 0.75rem; background: var(--ui-bg-muted); }
.chat__preview-image { display: block; max-width: 6rem; max-height: 6rem; object-fit: contain; border-radius: 0.5rem; }
.chat__preview-name { min-width: 0; flex: 1 1 8rem; overflow-wrap: anywhere; font-size: 0.875rem; }
.chat__retention { grid-column: 1 / -1; display: grid; gap: 0.3rem; color: var(--ui-text-muted); font-size: 0.875rem; }
.chat__retention select { width: 100%; min-height: var(--touch-target); padding-inline: 0.6rem; border: 1px solid var(--ui-border); border-radius: 0.5rem; background: var(--ui-bg); color: var(--ui-text); }
.chat__error { grid-column: 1 / -1; color: var(--ui-error); font-size: 0.875rem; }
.chat__status { grid-column: 1 / -1; color: var(--ui-text-muted); font-size: 0.875rem; }
.chat__preparing { grid-column: 1 / -1; display: flex; align-items: center; gap: 0.5rem; color: var(--ui-text-muted); font-size: 0.875rem; }
.chat__attachments, .chat__preview { grid-column: 1 / -1; }
.chat__field {
  min-width: 0;
  width: 100%;
}
.chat__send {
  width: 100%;
  min-height: var(--touch-target);
  justify-content: center;
}
@media (min-width: 40rem) {
  .chat__form {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .chat__send { grid-column: 2; grid-row: 1; }
  .chat__message {
    max-width: 82%;
  }
}
</style>
