<template>
  <UModal
    v-model:open="open"
    title="Разметка фото"
    description="Отметьте нужное прямо на снимке"
    :ui="{ content: 'max-w-4xl' }"
  >
    <template #body>
      <div class="markup">
        <p v-if="error" role="alert" class="markup__error">{{ error }}</p>
        <p v-if="submitError" role="alert" class="markup__error">{{ submitError }} Повторите сохранение или обновите чат.</p>
        <canvas
          ref="canvas"
          class="markup__canvas"
          aria-label="Рисование поверх фото"
          @pointerdown="start"
          @pointermove="move"
          @pointerup="finish"
          @pointercancel="finish"
        />
        <UFormField label="Сообщение к фото (необязательно)">
          <UTextarea v-model="caption" class="w-full" :rows="2" :maxlength="2000" :disabled="sending || retry" placeholder="Например: нужен вот этот товар" />
        </UFormField>
        <div class="markup__tools">
          <fieldset class="markup__colors">
            <legend>Цвет</legend>
            <button
              v-for="option in colors"
              :key="option.value"
              type="button"
              class="markup__color"
              :class="{ 'markup__color--active': color === option.value }"
              :style="{ backgroundColor: option.value }"
              :aria-label="option.label"
              :aria-pressed="color === option.value"
              :disabled="sending || retry"
              @click="color = option.value"
            />
          </fieldset>
          <label class="markup__width"
            >Толщина
            <select v-model.number="width" aria-label="Толщина линии" :disabled="sending || retry">
              <option :value="3">Тонкая</option>
              <option :value="6">Средняя</option>
              <option :value="10">Толстая</option>
            </select>
          </label>
          <UButton
            variant="soft"
            color="neutral"
            :disabled="!strokes.length || sending || retry"
            @click="undo"
            >Отменить линию</UButton
          >
          <UButton
            variant="soft"
            color="neutral"
            :disabled="!strokes.length || sending || retry"
            @click="clear"
            >Очистить</UButton
          >
        </div>
      </div>
    </template>
    <template #footer>
      <UButton
        variant="ghost"
        color="neutral"
        :disabled="busy || sending"
        @click="open = false"
        >Отмена</UButton
      >
      <UButton :loading="busy || sending" :disabled="!ready || busy || sending" @click="retry ? emit('retry') : send()"
        >{{ retry ? 'Повторить сохранение' : revision ? 'Сохранить разметку' : 'Отправить фото' }}</UButton
      >
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { MAX_CHAT_PHOTO_BYTES } from "~/utils/chat-photo";
const props = withDefaults(defineProps<{ file: File; revision?: boolean; sending?: boolean;
  retry?: boolean; submitError?: string }>(), { revision: false, sending: false, retry: false, submitError: '' });
const emit = defineEmits<{ send: [file: File]; retry: [] }>();
const open = defineModel<boolean>("open", { required: true });
const caption = defineModel<string>("text", { required: true });
const canvas = ref<HTMLCanvasElement>();
const ready = ref(false);
const busy = ref(false);
const error = ref("");
const colors = [
  { value: "#f43f5e", label: "Красный" },
  { value: "#facc15", label: "Жёлтый" },
  { value: "#38bdf8", label: "Голубой" },
];
const color = ref(colors[0]!.value);
const width = ref(6);
type Point = { x: number; y: number };
type Stroke = { points: Point[]; color: string; width: number };
const strokes = ref<Stroke[]>([]);
let photo: HTMLImageElement | null = null;
let drawing = false;
let generation = 0;

async function load() {
  const target = canvas.value;
  if (!target || !open.value) return;
  const current = ++generation;
  ready.value = false;
  error.value = "";
  const url = URL.createObjectURL(props.file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (current !== generation || !canvas.value) return;
    const scale = Math.min(
      1,
      4096 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    target.width = Math.max(1, Math.round(image.naturalWidth * scale));
    target.height = Math.max(1, Math.round(image.naturalHeight * scale));
    photo = image;
    strokes.value = [];
    redraw();
    ready.value = true;
  } catch {
    error.value = "Не удалось открыть фото для разметки";
  } finally {
    URL.revokeObjectURL(url);
  }
}

function redraw() {
  const target = canvas.value;
  const context = target?.getContext("2d");
  if (!target || !context || !photo) return;
  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(photo, 0, 0, target.width, target.height);
  for (const stroke of strokes.value) {
    if (stroke.points.length === 1) {
      const point = stroke.points[0]!;
      context.beginPath();
      context.fillStyle = stroke.color;
      context.arc(point.x, point.y, stroke.width / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const [index, point] of stroke.points.entries()) {
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
    context.stroke();
  }
}

function point(event: PointerEvent): Point {
  const target = canvas.value!;
  const rect = target.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) * target.width) / rect.width,
    y: ((event.clientY - rect.top) * target.height) / rect.height,
  };
}

function start(event: PointerEvent) {
  if (!ready.value || !canvas.value || props.sending || props.retry) return;
  event.preventDefault();
  const rect = canvas.value.getBoundingClientRect();
  if (!rect.width) return;
  canvas.value.setPointerCapture(event.pointerId);
  drawing = true;
  strokes.value.push({
    points: [point(event)],
    color: color.value,
    width: (width.value * canvas.value.width) / rect.width,
  });
  redraw();
}
function move(event: PointerEvent) {
  if (!drawing) return;
  strokes.value.at(-1)?.points.push(point(event));
  redraw();
}
function finish() {
  drawing = false;
}
function undo() {
  strokes.value.pop();
  redraw();
}
function clear() {
  strokes.value = [];
  redraw();
}
async function send() {
  if (!canvas.value || !ready.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const target = canvas.value;
    let blob = await new Promise<Blob>((resolve, reject) =>
      target.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("canvas"))),
        "image/webp",
        0.88,
      ),
    );
    if (blob.size > MAX_CHAT_PHOTO_BYTES && blob.type === "image/webp")
      blob = await new Promise<Blob>((resolve, reject) =>
        target.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("canvas"))),
          "image/webp",
          0.75,
        ),
      );
    if (blob.size > MAX_CHAT_PHOTO_BYTES) {
      error.value = "Размеченное фото больше 20 МБ. Попробуйте уменьшить исходный файл.";
      return;
    }
    const mime = blob.type === "image/webp" ? "image/webp" : "image/png";
    emit("send", new File([blob], mime === "image/webp" ? "photo.webp" : "photo.png", { type: mime }));
  } catch {
    error.value = "Не удалось подготовить фото. Попробуйте ещё раз.";
  } finally {
    busy.value = false;
  }
}
watch(canvas, (value) => {
  if (value) void load();
});
watch(
  () => props.file,
  () => {
    if (canvas.value) void load();
  },
);
watch(open, (value) => {
  if (value && canvas.value) void load();
});
onBeforeUnmount(() => {
  generation++;
});
</script>

<style scoped>
.markup {
  display: grid;
  gap: 1rem;
  min-width: 0;
}
.markup__canvas {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: 65dvh;
  height: auto;
  margin-inline: auto;
  border-radius: 0.75rem;
  touch-action: none;
  cursor: crosshair;
}
.markup__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.75rem;
}
.markup__colors {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.markup__colors legend,
.markup__width {
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}
.markup__color {
  width: 2rem;
  height: 2rem;
  border: 2px solid var(--ui-border);
  border-radius: 999px;
  cursor: pointer;
}
.markup__color--active {
  outline: 2px solid var(--ui-text);
  outline-offset: 2px;
}
.markup__width {
  display: grid;
  gap: 0.25rem;
}
.markup__width select {
  min-height: 2rem;
  padding-inline: 0.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  background: var(--ui-bg);
  color: var(--ui-text);
}
.markup__error {
  color: var(--ui-error);
}
</style>
