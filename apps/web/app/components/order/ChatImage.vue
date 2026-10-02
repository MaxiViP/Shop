<template>
  <div class="chat-image">
    <p v-if="gone" class="chat-image__status">Фото больше не хранится</p>
    <p v-else-if="loading" role="status" class="chat-image__status">Загружаем фото…</p>
    <div v-else-if="error" class="chat-image__status">
      <p>Не удалось загрузить фото.</p>
      <UButton size="sm" variant="soft" @click="loadThumb">Повторить</UButton>
    </div>
    <div v-else class="chat-image__available">
      <button
        type="button"
        class="chat-image__open"
        aria-label="Открыть фото крупнее"
        @click="show"
      >
        <img :src="thumb" alt="Фото в сообщении" class="chat-image__thumb">
      </button>
      <UButton type="button" size="sm" variant="soft" icon="i-lucide-pencil" :loading="marking" :disabled="fullLoading" @click="mark">Отметить на фото</UButton>
      <div v-if="markError" role="alert" class="chat-image__status">
        Не удалось подготовить фото для разметки.
        <UButton type="button" size="sm" variant="ghost" @click="mark">Повторить</UButton>
      </div>
    </div>
    <UModal v-model:open="open" title="Фото в чате" :ui="{ content: 'max-w-5xl' }">
      <template #body>
        <p v-if="fullLoading" role="status">Загружаем большое фото…</p>
        <div v-else-if="fullError" class="chat-image__status">
          <p>Не удалось открыть фото.</p>
          <UButton size="sm" variant="soft" @click="loadFull">Повторить</UButton>
        </div>
        <div v-else-if="full" class="chat-image__full-view">
          <img :src="full" alt="Фото в сообщении крупным планом" class="chat-image__full">
          <UButton type="button" size="sm" variant="soft" icon="i-lucide-pencil" :loading="marking" @click="mark">Отметить на фото</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ base: string; id: number; expired?: boolean }>();
const emit = defineEmits<{ mark: [file: File] }>();
const api = useApiClient();
const thumb = ref("");
const full = ref("");
const fullBlob = shallowRef<Blob | null>(null);
const loading = ref(!props.expired);
const fullLoading = ref(false);
const marking = ref(false);
const markError = ref(false);
const error = ref(false);
const fullError = ref(false);
const gone = ref(Boolean(props.expired));
const open = ref(false);
let active = true;

function isGone(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const status = cause as { status?: number; statusCode?: number };
  return status.status === 410 || status.statusCode === 410;
}
async function loadThumb() {
  if (gone.value) return;
  loading.value = true;
  error.value = false;
  try {
    const blob = await api<Blob>(props.base + "/messages/" + props.id + "/thumbnail", {
      responseType: "blob",
    });
    if (!active) return;
    if (thumb.value) URL.revokeObjectURL(thumb.value);
    thumb.value = URL.createObjectURL(blob);
  } catch (cause) {
    if (active) {
      if (isGone(cause)) gone.value = true;
      else error.value = true;
    }
  } finally {
    if (active) loading.value = false;
  }
}
async function loadFull(): Promise<Blob | null> {
  if (gone.value || fullLoading.value) return null;
  if (fullBlob.value) return fullBlob.value;
  fullLoading.value = true;
  fullError.value = false;
  try {
    const blob = await api<Blob>(props.base + "/messages/" + props.id + "/image", {
      responseType: "blob",
    });
    if (!active || blob.type !== "image/webp") throw new Error("Invalid image response");
    fullBlob.value = blob;
    full.value = URL.createObjectURL(blob);
    return blob;
  } catch (cause) {
    if (active) {
      if (isGone(cause)) { gone.value = true; open.value = false; }
      else fullError.value = true;
    }
    return null;
  } finally {
    if (active) fullLoading.value = false;
  }
}
async function mark() {
  if (marking.value || gone.value) return;
  marking.value = true;
  markError.value = false;
  try {
    const blob = await loadFull();
    if (!blob) {
      if (!gone.value) markError.value = true;
      return;
    }
    open.value = false;
    await nextTick();
    if (active) emit("mark", new File([blob], "photo.webp", { type: "image/webp" }));
  } finally {
    marking.value = false;
  }
}
function show() {
  open.value = true;
  void loadFull();
}
watch(() => props.expired, value => { if (value) gone.value = true; });
watch(gone, value => {
  if (!value) return;
  open.value = false;
  if (thumb.value) URL.revokeObjectURL(thumb.value);
  if (full.value) URL.revokeObjectURL(full.value);
  thumb.value = "";
  full.value = "";
  fullBlob.value = null;
});
onMounted(() => { if (!gone.value) void loadThumb(); });
onBeforeUnmount(() => {
  active = false;
  if (thumb.value) URL.revokeObjectURL(thumb.value);
  if (full.value) URL.revokeObjectURL(full.value);
});
</script>

<style scoped>
.chat-image { min-width: 0; }
.chat-image__status { color: var(--ui-text-muted); font-size: 0.875rem; }
.chat-image__available { display: grid; justify-items: start; gap: 0.5rem; min-width: 0; }
.chat-image__open { display: block; max-width: 100%; border-radius: 0.5rem; cursor: zoom-in; overflow: hidden; }
.chat-image__open:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.chat-image__thumb { display: block; max-width: min(100%, 18rem); max-height: 16rem; object-fit: contain; }
.chat-image__full { display: block; max-width: 100%; max-height: 82dvh; margin-inline: auto; object-fit: contain; }
.chat-image__full-view { display: grid; justify-items: center; gap: 0.75rem; }
</style>
