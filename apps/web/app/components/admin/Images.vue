<template>
  <section class="images">
    <div>
      <h2 class="images__title">Фотографии товара</h2>
      <p class="images__hint">
        До 8 фото · JPEG, PNG, WebP · до 5 МБ и 25 мегапикселей
      </p>
    </div>
    <div
      class="images__drop"
      :class="{ 'images__drop--active': dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="drop"
    >
      <UIcon name="i-lucide-image-plus" class="images__drop-icon" />
      <p>Перетащите фотографии сюда</p>
      <span class="images__hint">или</span>
      <UButton
        icon="i-lucide-plus"
        :disabled="busy || images.length >= 8"
        @click="picker?.click()"
        >Выбрать фотографии</UButton
      >
      <input
        ref="picker"
        type="file"
        class="images__file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        :disabled="busy || images.length >= 8"
        aria-label="Добавить фотографии"
        @change="pick"
      >
    </div>
    <UAlert v-if="error" color="error" :title="error" />
    <div v-if="pending.length" class="images__pending" role="status">
      <p>Загрузка {{ completed }} из {{ pending.length }}…</p>
      <progress
        :value="completed"
        :max="pending.length"
        aria-label="Загружено фотографий"
      />
      <div class="images__previews">
        <img
          v-for="item in pending"
          :key="item.url"
          :src="item.url"
          :alt="item.name"
        >
      </div>
    </div>
    <p v-else-if="busy" role="status">Сохраняем изменения…</p>
    <p v-if="!images.length && !pending.length" class="images__hint">
      Фото пока нет. Добавьте первое — оно станет основным.
    </p>
    <div class="images__grid">
      <article
        v-for="image in images"
        :key="image.id"
        class="images__card"
        :class="{
          'images__card--primary': image.id === primaryId,
          'images__card--hidden': !image.visible,
        }"
      >
        <div class="images__preview">
          <img
            :src="asset(image.url)"
            :alt="image.alt || productName"
            loading="lazy"
          >
        </div>
        <div class="images__body">
          <UBadge
            :color="
              image.id === primaryId
                ? 'primary'
                : image.visible
                  ? 'success'
                  : 'neutral'
            "
          >
            {{
              image.id === primaryId
                ? "Основная"
                : image.visible
                  ? "В галерее"
                  : "Скрыта"
            }}
          </UBadge>
          <label class="images__choice">
            <input
              v-model="selectedPrimary"
              type="radio"
              :name="`primary-image-${productId}`"
              :value="image.id"
              :disabled="busy"
              @change="makePrimary(image)"
            >
            Основная
          </label>
          <label class="images__choice">
            <input
              type="checkbox"
              :checked="image.visible"
              :disabled="busy || image.id === primaryId"
              @change="visibility(image, $event)"
            >
            Показывать в галерее
          </label>
          <p v-if="image.id === primaryId" class="images__hint">
            Чтобы скрыть, сначала выберите другую основную.
          </p>
          <form class="images__form" @submit.prevent="save(image)">
            <UFormField label="Alt — описание фото"
              ><UInput
                v-model="drafts[image.id]!.alt"
                :disabled="busy"
                maxlength="300"
                class="w-full"
            /></UFormField>
            <UFormField label="Порядок"
              ><UInput
                v-model.number="drafts[image.id]!.sort"
                type="number"
                required
                min="-1000000"
                max="1000000"
                step="1"
                :disabled="busy"
                class="w-full"
            /></UFormField>
            <div class="images__actions">
              <UButton type="submit" variant="outline" :disabled="busy"
                >Сохранить</UButton
              >
              <UButton
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :disabled="busy"
                aria-label="Удалить фотографию"
                @click="
                  selected = image;
                  confirm = true;
                "
              />
            </div>
          </form>
        </div>
      </article>
    </div>
    <AdminConfirm
      v-model:open="confirm"
      title="Удалить фотографию?"
      :busy="busy"
      @confirm="remove"
    />
  </section>
</template>

<script setup lang="ts">
import type { AdminImage } from "~/types/admin";
const props = defineProps<{
  productId: number;
  productName: string;
  value: AdminImage[];
}>();
const emit = defineEmits<{ refresh: [] }>();
const images = ref<AdminImage[]>([]);
const drafts = reactive<Record<number, { alt: string; sort: number }>>({});
function apply(value: AdminImage[]) {
  images.value = [...value].sort((a, b) => a.sort - b.sort || a.id - b.id);
  for (const image of value)
    drafts[image.id] ??= { alt: image.alt ?? "", sort: image.sort };
}
watch(() => props.value, apply, { immediate: true });
const primaryId = computed(
  () => images.value.find((image) => image.visible)?.id,
);
const selectedPrimary = ref<number>();
watch(
  primaryId,
  (value) => {
    selectedPrimary.value = value;
  },
  { immediate: true },
);
const api = useApiClient();
const toast = useToast();
const asset = useAsset();
const picker = ref<HTMLInputElement>();
const busy = ref(false);
const dragging = ref(false);
const error = ref("");
const confirm = ref(false);
const selected = ref<AdminImage>();
const pending = ref<{ url: string; name: string }[]>([]);
const completed = ref(0);
function clearPreviews() {
  for (const item of pending.value) URL.revokeObjectURL(item.url);
  pending.value = [];
}
onBeforeUnmount(clearPreviews);
function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  void upload(Array.from(input.files ?? []));
  input.value = "";
}
function drop(event: DragEvent) {
  dragging.value = false;
  void upload(Array.from(event.dataTransfer?.files ?? []));
}
async function reload() {
  const product = await api<{ images: AdminImage[] }>(
    `/admin/products/${props.productId}`,
  );
  apply(product.images);
  for (const image of product.images)
    if (drafts[image.id]) drafts[image.id]!.sort = image.sort;
  emit("refresh");
}
async function upload(files: File[]) {
  if (!files.length || busy.value) return;
  error.value = "";
  if (
    files.length + images.value.length > 8 ||
    files.some(
      (file) =>
        file.size > 5 * 1024 * 1024 ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type),
    )
  ) {
    error.value = "Не более 8 фото. JPEG, PNG или WebP, каждое до 5 МБ.";
    return;
  }
  busy.value = true;
  completed.value = 0;
  pending.value = files.map((file) => ({
    url: URL.createObjectURL(file),
    name: file.name,
  }));
  try {
    for (const file of files) {
      const body = new FormData();
      body.append("file", file);
      const image = await api<AdminImage>(
        `/admin/products/${props.productId}/images`,
        { method: "POST", body },
      );
      apply([...images.value, image]);
      completed.value++;
    }
    toast.add({ title: "Фото загружено", color: "success" });
  } catch (cause) {
    error.value = apiError(cause);
  } finally {
    clearPreviews();
    busy.value = false;
    emit("refresh");
  }
}
async function mutate(
  image: AdminImage,
  body: { visible?: boolean; alt?: string | null; sort?: number } | null,
) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/admin/products/${props.productId}/images/${image.id}${body === null ? "/primary" : ""}`,
      {
        method: body === null ? "POST" : "PATCH",
        ...(body === null ? {} : { body }),
      },
    );
    await reload();
    toast.add({
      title:
        body === null ? "Основная фотография изменена" : "Изменения сохранены",
      color: "success",
    });
  } catch (cause) {
    error.value = apiError(cause);
  } finally {
    busy.value = false;
  }
}
async function makePrimary(image: AdminImage) {
  await mutate(image, null);
  selectedPrimary.value = primaryId.value;
}
async function visibility(image: AdminImage, event: Event) {
  const input = event.target as HTMLInputElement;
  await mutate(image, { visible: input.checked });
  input.checked =
    images.value.find((item) => item.id === image.id)?.visible ?? false;
}
function save(image: AdminImage) {
  const draft = drafts[image.id]!;
  return mutate(image, { alt: draft.alt.trim() || null, sort: draft.sort });
}
async function remove() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/admin/products/${props.productId}/images/${selected.value.id}`,
      { method: "DELETE" },
    );
    await reload();
    confirm.value = false;
    toast.add({ title: "Фото удалено", color: "success" });
  } catch (cause) {
    error.value = apiError(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.images {
  display: grid;
  gap: 1rem;
}
.images__title {
  font-size: var(--section-title);
  font-weight: 600;
}
.images__hint {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.images__drop {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1.5rem;
  border: 2px dashed var(--ui-border);
  border-radius: 1rem;
  background: var(--ui-bg-muted);
  text-align: center;
}
.images__drop--active {
  border-color: var(--ui-primary);
}
.images__drop-icon {
  width: 1.5rem;
  height: 1.5rem;
  color: var(--ui-primary);
}
.images__file {
  display: none;
}
.images__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
  gap: 1rem;
}
.images__card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: var(--ui-bg);
}
.images__card--primary {
  border-color: var(--ui-primary);
  box-shadow: 0 0 0 1px var(--ui-primary);
}
.images__card--hidden .images__preview {
  opacity: 0.55;
}
.images__preview {
  aspect-ratio: 4 / 3;
  background: var(--ui-bg-muted);
}
.images__preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.images__body,
.images__form {
  display: grid;
  gap: 0.75rem;
}
.images__body {
  padding: 1rem;
}
.images__body > :first-child {
  justify-self: start;
}
.images__choice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  font-size: 0.875rem;
  cursor: pointer;
}
.images__choice input {
  accent-color: var(--ui-primary);
  width: 1rem;
  height: 1rem;
}
.images__actions {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
.images__actions :deep(button) {
  min-height: 44px;
}
.images__pending {
  display: grid;
  gap: 0.5rem;
}
.images__previews {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
}
.images__previews img {
  width: 4rem;
  height: 4rem;
  object-fit: cover;
  border-radius: 0.5rem;
}
</style>
