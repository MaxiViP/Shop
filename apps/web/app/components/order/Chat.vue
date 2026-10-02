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
        :data-message-id="entry.id"
        class="chat__message"
        :class="{
          'chat__message--system': entry.authorType === 'SYSTEM',
          'chat__message--customer': entry.authorType === 'CUSTOMER',
          'chat__message--unread-photo': unreadRevision?.messageId === entry.id,
        }"
      >
        <p v-if="unreadRevision?.messageId === entry.id" class="chat__unread-photo">Непрочитанное обновление фото</p>
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
        <OrderChatImage v-if="entry.image" :id="entry.id" :base="base" :revision="entry.imageRevision" :expired="entry.imageExpired" @mark="markImage" @ready="imageReady(entry.id, $event)" />
        <p v-if="entry.imageRevision && entry.revisionActor" class="chat__revision">
          {{ entry.revisionActor === 'CUSTOMER' ? 'Отмечено покупателем' : `Фото обновлено: ${author(entry.revisionActor)}` }} ·
          <time v-if="entry.revisionAt" :datetime="entry.revisionAt">{{ new Date(entry.revisionAt).toLocaleString('ru-RU') }}</time>
        </p>
        <p v-if="entry.revisionText" class="chat__revision-text">{{ entry.revisionText }}</p>
      </article>
    </div>
    <p v-if="unread" role="status" class="text-primary text-sm">
      Непрочитанных обновлений: {{ unread }}
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
        <UButton type="button" size="sm" variant="soft" color="neutral" icon="i-lucide-image-plus" :disabled="sending || preparing" @click="photoInput?.click()">Фото</UButton>
        <UButton type="button" size="sm" variant="soft" color="neutral" icon="i-lucide-camera" :disabled="sending || preparing" @click="camera?.openCamera()">Камера</UButton>
        <UButton v-if="photo" type="button" size="sm" variant="soft" color="neutral" icon="i-lucide-pencil" :disabled="sending || preparing" @click="openNewMarkup">Разметка</UButton>
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
    <OrderCamera ref="camera" @select="cameraPhoto" @gallery="photoInput?.click()" />
    <OrderMarkup
      v-if="photo || markupSource"
      v-model:open="markupOpen"
      v-model:text="markupText"
      :file="markupSource ?? photo!"
      :revision="Boolean(markupTarget)"
      :sending="revisionSending"
      :retry="Boolean(revisionAttempt && revisionError)"
      :submit-error="revisionError"
      @send="sendMarked"
      @retry="saveRevision"
    />
  </UCard>
</template>

<script setup lang="ts">
import type { ChatMessage, MessagePage, OrderIssue } from "~/types/coordination";
import {
  createChatHistory,
  applyImageRevisions,
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
const unreadRevision = ref<MessagePage['unreadRevision']>(null);
const oldestPageId = ref<number>();
const readyImages = reactive(new Map<number, number>());
const text = ref("");
const markupText = ref("");
const photo = ref<File | null>(null);
const photoContext = ref('operational');
const preview = ref("");
const photoInput = ref<HTMLInputElement>();
const camera = ref<{ openCamera: () => void }>();
const markupOpen = ref(false);
const markupSource = ref<File | null>(null);
const markupTarget = ref<number | null>(null);
const revisionAttempt = ref<{ messageId: number; file: File; text: string; requestId: string } | null>(null);
const revisionSending = ref(false);
const revisionError = ref('');
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
let lastReadRevision = 0;
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
function photoVisible(messageId: number) {
  const frame = viewport.value?.getBoundingClientRect();
  const image = viewport.value?.querySelector<HTMLElement>(
    `[data-message-id="${messageId}"] .chat-image__thumb`);
  if (!frame || !image) return false;
  const photo = image.getBoundingClientRect();
  if (!photo.width || !photo.height) return false;
  const visible = Math.min(photo.bottom, frame.bottom, window.innerHeight) -
    Math.max(photo.top, frame.top, 0);
  return visible >= Math.min(48, photo.height / 2);
}
function imageReady(messageId: number, revision: number) {
  readyImages.set(messageId, revision);
  void markVisible();
}
async function markVisible() {
  const through = bottom() ? history.cursor ?? 0 : 0;
  const target = unreadRevision.value;
  const revisionThrough = target && readyImages.get(target.messageId) === target.message.imageRevision &&
    photoVisible(target.messageId) ? target.id : undefined;
  if (
    !active ||
    reading ||
    !inView ||
    document.visibilityState !== "visible" ||
    (through <= Math.max(lastRead, props.readThrough) &&
      (!revisionThrough || revisionThrough <= lastReadRevision))
  )
    return;
  reading = true;
  try {
    await api(`${props.base}/messages/read`, {
      method: "POST",
      body: { through, ...(revisionThrough ? { revisionThrough } : {}) },
    });
    if (active) {
      lastRead = Math.max(lastRead, through);
      if (revisionThrough) {
        lastReadRevision = Math.max(lastReadRevision, revisionThrough);
        if (unreadRevision.value?.id === revisionThrough) unreadRevision.value = null;
      }
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
  const wasInitial = !initialLoaded.value;
  try {
    const after = history.cursor;
    const seen = messages.value.filter(entry => entry.image).slice(-500).map(entry => entry.id).join(',');
    const page = await api<MessagePage>(`${props.base}/messages`, {
      query: { ...(after ? { after } : {}), ...(seen ? { seen } : {}) },
    });
    if (!active) return;
    if (!after) {
      hasOlder.value = page.hasMore;
      oldestPageId.value = page.messages[0]?.id;
    }
    const changed = receiveMessages(history, page.messages);
    const revised = applyImageRevisions(history, page.revisions ?? []);
    const newUnread = page.unreadRevision && page.unreadRevision.id !== unreadRevision.value?.id;
    unreadRevision.value = page.unreadRevision;
    if (page.messages.length && wasBottom && messages.value.length > 500) {
      messages.value = messages.value.slice(-500);
      oldestPageId.value = messages.value[0]?.id;
      hasOlder.value = true;
    }
    if (page.unreadRevision)
      messages.value = mergeMessages(messages.value, [page.unreadRevision.message]);
    error.value = false;
    await nextTick();
    if (newUnread && !wasInitial && route.hash === '#order-chat') await focusChat();
    else if ((changed || revised) && wasBottom && viewport.value)
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
      query: { before: oldestPageId.value },
    });
    if (!active) return;
    messages.value = mergeMessages(messages.value, page.messages);
    oldestPageId.value = page.messages[0]?.id ?? oldestPageId.value;
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
function cameraPhoto(file: File) {
  if (setPhoto(file)) photoContext.value = 'operational';
}
function openNewMarkup() {
  markupTarget.value = null;
  markupSource.value = null;
  markupText.value = text.value;
  markupOpen.value = true;
}
async function sendMarked(file: File) {
  if (markupTarget.value !== null) {
    revisionAttempt.value = { messageId: markupTarget.value, file,
      text: markupText.value.trim(), requestId: crypto.randomUUID() };
    await saveRevision();
  } else if (setPhoto(file)) {
    text.value = markupText.value;
    markupOpen.value = false;
    await send();
  }
}
async function saveRevision() {
  const attempt = revisionAttempt.value;
  if (!attempt || revisionSending.value) return;
  revisionSending.value = true;
  revisionError.value = '';
  try {
    const body = new FormData();
    body.append('text', attempt.text);
    body.append('requestId', attempt.requestId);
    body.append('file', attempt.file);
    const entry = await api<ChatMessage>(`${props.base}/messages/${attempt.messageId}/revisions`,
      { method: 'POST', body });
    if (!active) return;
    messages.value = mergeMessages(messages.value, [entry]);
    revisionAttempt.value = null;
    markupOpen.value = false;
    toast.add({ title: 'Разметка сохранена' });
  } catch (cause) {
    if (active) revisionError.value = apiError(cause);
  } finally {
    revisionSending.value = false;
  }
}
function markImage(value: { id: number; file: File }) {
  markupSource.value = value.file;
  markupTarget.value = value.id;
  markupText.value = '';
  revisionAttempt.value = null;
  revisionError.value = '';
  markupOpen.value = true;
}
async function focusChat() {
  if (route.hash !== '#order-chat') return;
  await nextTick();
  document.getElementById('order-chat')?.scrollIntoView({ block: 'start' });
  const target = unreadRevision.value && viewport.value?.querySelector<HTMLElement>(
    `[data-message-id="${unreadRevision.value.messageId}"]`);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    void markVisible();
  } else if (window.matchMedia('(min-width: 40rem)').matches)
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
  void load().then(focusChat);
});
onBeforeUnmount(() => {
  active = false;
  cancelPhotoPreparation();
  observer?.disconnect();
  if (preview.value) URL.revokeObjectURL(preview.value);
});
watch(() => route.hash, () => { void focusChat() });
watch(() => props.unread, () => { void markVisible() });
watch(markupOpen, (open) => {
  if (!open) {
    markupSource.value = null;
    markupTarget.value = null;
    revisionAttempt.value = null;
    revisionError.value = '';
  }
});
useOrderPolling(load, () => props.poll === false ? 30000 : 4000);
</script>

<style scoped>
.chat {
  min-width: 0;
  scroll-margin-top: calc(var(--header-height) + 4.5rem);
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
.chat__revision { color: var(--ui-text-muted); font-size: 0.75rem; }
.chat__revision-text { border-left: 2px solid var(--ui-primary); padding-left: 0.5rem; font-size: 0.875rem; }
.chat__unread-photo { color: var(--ui-primary); font-size: 0.75rem; font-weight: 600; }
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
.chat__message--unread-photo { border-color: var(--ui-primary); }
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
