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
        <p class="chat__text">{{ entry.text }}</p>
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
      <UButton
        type="submit"
        :loading="sending"
        :disabled="!text.trim() || sending"
        class="chat__send"
        >Отправить</UButton
      >
    </form>
  </UCard>
</template>

<script setup lang="ts">
import type { ChatMessage, MessagePage } from "~/types/coordination";
import {
  createChatHistory,
  mergeMessages,
  receiveMessages,
} from "~/utils/chat-messages";
const props = defineProps<{
  base: string;
  staff: boolean;
  unread: number;
  readThrough: number;
  poll?: boolean;
}>();
const emit = defineEmits<{ read: [] }>();
const api = useApiClient();
const toast = useToast();
const communicationRevision = useCommunicationRevision();
const history = reactive(createChatHistory());
const { messages, initialLoaded } = toRefs(history);
const text = ref("");
const loading = ref(false);
const loadingOlder = ref(false);
const sending = ref(false);
const error = ref(false);
const hasOlder = ref(false);
const viewport = ref<HTMLElement>();
let active = true;
let inView = false;
let observer: IntersectionObserver | undefined;
let reading = false;
let lastRead = 0;
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
  if (sending.value || !text.value.trim()) return;
  sending.value = true;
  try {
    const entry = await api<ChatMessage>(`${props.base}/messages`, {
      method: "POST",
      body: { text: text.value.trim() },
    });
    if (active) {
      text.value = "";
      messages.value = mergeMessages(messages.value, [entry]);
      await nextTick();
      if (viewport.value)
        viewport.value.scrollTop = viewport.value.scrollHeight;
    }
  } catch (cause) {
    toast.add({ title: apiError(cause), color: "error" });
  } finally {
    sending.value = false;
  }
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
});
onBeforeUnmount(() => {
  active = false;
  observer?.disconnect();
});
useOrderPolling(load, () => props.poll === false ? 30000 : 4000);
</script>

<style scoped>
.chat {
  min-width: 0;
  scroll-margin-top: calc(var(--header-height) + 1rem);
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
.chat__form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  align-items: end;
  gap: 0.75rem;
  padding-top: 1rem;
  padding-bottom: env(safe-area-inset-bottom);
}
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
  .chat__message {
    max-width: 82%;
  }
}
</style>
