<template>
  <UModal v-model:open="open" title="Камера" description="Сделайте снимок для чата" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <div class="camera">
        <p v-if="loading" role="status">Открываем камеру…</p>
        <p v-if="error" role="alert" class="camera__error">{{ error }}</p>
        <video v-show="stream && !error" ref="video" class="camera__video" autoplay muted playsinline aria-label="Предпросмотр камеры" />
      </div>
    </template>
    <template #footer>
      <UButton type="button" variant="ghost" color="neutral" @click="close">Отмена</UButton>
      <UButton v-if="error" type="button" variant="soft" icon="i-lucide-image-plus" @click="gallery">Выбрать фото</UButton>
      <UButton v-else type="button" icon="i-lucide-camera" :loading="capturing" :disabled="!stream || loading" @click="capture">Снять фото</UButton>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { chatCameraConstraints, chatCameraError } from '~/utils/chat-camera';
import { MAX_CHAT_PHOTO_BYTES } from '~/utils/chat-photo';

const emit = defineEmits<{ select: [file: File]; gallery: [] }>();
const open = ref(false);
const video = ref<HTMLVideoElement>();
const stream = shallowRef<MediaStream | null>(null);
const loading = ref(false);
const capturing = ref(false);
const error = ref('');
let generation = 0;

function stop() {
  generation++;
  stream.value?.getTracks().forEach(track => track.stop());
  stream.value = null;
  if (video.value) video.value.srcObject = null;
  loading.value = false;
}
function close() { open.value = false; stop(); }
async function attach() {
  if (!video.value || !stream.value) return;
  video.value.srcObject = stream.value;
  try { await video.value.play(); }
  catch (cause) { if (open.value) { error.value = chatCameraError(cause); stop(); } }
}
async function openCamera() {
  stop();
  const current = generation;
  error.value = '';
  open.value = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    error.value = 'Этот браузер не предоставляет доступ к камере. Выберите «Фото» из галереи.';
    return;
  }
  loading.value = true;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia(chatCameraConstraints);
    if (current !== generation || !open.value) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream.value = acquired;
    await nextTick();
    await attach();
  } catch (cause) {
    if (current === generation && open.value) error.value = chatCameraError(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function capture() {
  if (!video.value || !stream.value || capturing.value) return;
  capturing.value = true;
  error.value = '';
  const canvas = document.createElement('canvas');
  try {
    const width = video.value.videoWidth;
    const height = video.value.videoHeight;
    if (!width || !height || width * height > 60_000_000) throw new Error('Invalid camera frame');
    const scale = Math.min(1, 4096 / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(video.value, 0, 0, canvas.width, canvas.height);
    const encode = (quality: number) => new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG unavailable')), 'image/jpeg', quality));
    let blob = await encode(0.9);
    if (blob.size > MAX_CHAT_PHOTO_BYTES) blob = await encode(0.78);
    if (blob.type !== 'image/jpeg' || blob.size > MAX_CHAT_PHOTO_BYTES) throw new Error('Photo too large');
    emit('select', new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
    close();
  } catch {
    error.value = 'Не удалось сделать снимок. Попробуйте ещё раз или выберите «Фото».';
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    capturing.value = false;
  }
}
function gallery() { emit('gallery'); close(); }
watch(video, () => { void attach(); });
watch(open, value => { if (!value) stop(); });
onBeforeUnmount(stop);
defineExpose({ openCamera });
</script>

<style scoped>
.camera { min-height: 12rem; display: grid; place-items: center; }
.camera__video { display: block; width: 100%; max-height: 70dvh; border-radius: 0.75rem; object-fit: contain; background: #0b1220; }
.camera__error { color: var(--ui-error); }
</style>
