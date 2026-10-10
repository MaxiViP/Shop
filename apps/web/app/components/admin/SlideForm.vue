<template>
  <form class="space-y-5" @submit.prevent="save(true)">
    <fieldset :disabled="busy" class="space-y-5">
      <div class="grid sm:grid-cols-2 gap-4">
        <UFormField label="Тип слайда"><USelect v-model="form.type" :items="types" class="w-full" /></UFormField>
        <UFormField label="Содержимое"><USelect v-model="form.content" :items="contents" class="w-full" @update:model-value="chooseContent" /></UFormField>
        <UFormField label="Заголовок" required class="sm:col-span-2">
          <UTextarea v-model="form.title" :rows="2" maxlength="140" required class="w-full" />
        </UFormField>
        <UFormField label="Описание" class="sm:col-span-2"><UTextarea v-model="form.text" :rows="3" maxlength="420" class="w-full" /></UFormField>
        <p v-if="form.content === 'FREE_DELIVERY'" class="sm:col-span-2 text-sm text-muted">Шаблон {threshold} заменяется актуальным порогом из настроек доставки. Когда бесплатная доставка отключена, слайд скрыт.</p>
        <p v-if="form.content === 'SEASONAL' || form.content === 'HITS'" class="sm:col-span-2 text-sm text-muted">Ссылка ведёт в подборку товаров. Если подходящих опубликованных товаров нет, слайд скрыт.</p>
        <UFormField label="Короткий акцент"><UInput v-model="form.eyebrow" maxlength="60" class="w-full" /></UFormField>
        <UFormField label="Текст кнопки"><UInput v-model="form.buttonLabel" maxlength="50" class="w-full" /></UFormField>
        <UFormField label="Адрес перехода" class="sm:col-span-2" help="Путь сайта, например /catalog, или HTTPS-ссылка.">
          <UInput v-model="form.to" maxlength="2000" :disabled="form.content === 'SEASONAL' || form.content === 'HITS'" class="w-full" />
        </UFormField>
        <UFormField label="Фоновое изображение"><USelect v-model="form.image" :items="images" class="w-full" /></UFormField>
        <UFormField label="Положение изображения"><USelect v-model="form.position" :items="positions" class="w-full" /></UFormField>
        <UFormField label="Загрузить или заменить изображение" class="sm:col-span-2" help="JPEG, PNG или WebP до 5 МБ. Изображение будет оптимизировано в WebP.">
          <input type="file" accept="image/jpeg,image/png,image/webp" class="block w-full text-sm" @change="upload">
        </UFormField>
        <UFormField label="Начало показа · Москва"><UInput v-model="startsAt" type="datetime-local" class="w-full" /></UFormField>
        <UFormField label="Окончание показа · Москва" :required="form.type === 'TEMPORARY'"><UInput v-model="endsAt" type="datetime-local" class="w-full" /></UFormField>
        <UFormField label="Порядок"><UInput v-model.number="form.sortOrder" type="number" min="-1000000" max="1000000" step="1" class="w-full" /></UFormField>
        <div class="space-y-3 self-end">
          <USwitch v-model="form.active" label="Слайд включён" />
          <USwitch v-model="form.priority" label="Показывать первым" />
        </div>
      </div>
      <p class="text-sm text-muted">Время указано по Москве. Для временного слайда нужно окончание. «Показывать первым» заменяет приоритет другого опубликованного слайда. Расписание объявления не запускает скидку на товары.</p>
      <UAlert v-if="error" color="error" :title="error" />
      <div class="flex flex-wrap gap-2">
        <UButton type="submit" :loading="busy">{{ form.published ? 'Сохранить публикацию' : 'Опубликовать' }}</UButton>
        <UButton type="button" variant="outline" :disabled="busy" @click="save(false)">{{ form.published ? 'Снять с публикации в черновик' : 'Сохранить черновик' }}</UButton>
        <UButton type="button" variant="ghost" :loading="previewBusy" @click="showPreview">Предпросмотр</UButton>
      </div>
    </fieldset>
    <section class="space-y-3" aria-label="Предпросмотр слайда">
      <div class="flex items-center gap-2">
        <h3 class="font-semibold mr-auto">Предпросмотр</h3>
        <UButton variant="ghost" :aria-pressed="mobile" icon="i-lucide-smartphone" @click="mobile = true">Мобильный</UButton>
        <UButton variant="ghost" :aria-pressed="!mobile" icon="i-lucide-monitor" @click="mobile = false">Десктоп</UButton>
      </div>
      <UAlert v-if="previewReason" color="warning" :title="previewReason" />
      <div v-if="preview" class="slide-preview" :class="{ 'slide-preview--mobile': mobile }">
        <img v-if="preview.image" class="slide-preview__image" :src="asset(preview.image)" :style="{ objectPosition: preview.position }" alt="">
        <div class="slide-preview__content">
          <p v-if="preview.eyebrow" class="slide-preview__label">{{ preview.eyebrow }}</p>
          <h3 class="slide-preview__title">{{ preview.title }}</h3>
          <p class="slide-preview__text">{{ preview.text }}</p>
          <UButton v-if="preview.buttonLabel && preview.to" size="lg" class="slide-preview__action" type="button">{{ preview.buttonLabel }}</UButton>
        </div>
      </div>
      <p class="text-sm text-muted">Предпросмотр показывает сохранённые в форме тексты. На главной остаются существующие навигация и блок выбора по фото.</p>
    </section>
  </form>
</template>

<script setup lang="ts">
import type { AdminHomeSlide, PublicHomeSlide, SlideInput } from '~/types/home-slide';
import { moscowInput, pickupDate } from '~/utils/pickup';
const props = defineProps<{ slide?: AdminHomeSlide; nextOrder: number }>();
const emit = defineEmits<{ saved: [] }>();
const id = ref(props.slide?.id);
const source = props.slide;
const form = reactive({
  type: source?.type ?? 'PERMANENT', content: source?.content ?? 'CUSTOM', title: source?.title ?? '', text: source?.text ?? '',
  eyebrow: source?.eyebrow ?? '', buttonLabel: source?.buttonLabel ?? '', to: source?.to ?? '', image: source?.image ?? '',
  position: source?.position ?? 'center', active: source?.active ?? true, published: source?.published ?? false,
  priority: source?.priority ?? false, sortOrder: source?.sortOrder ?? props.nextOrder,
});
const startsAt = ref(moscowInput(source?.startsAt));
const endsAt = ref(moscowInput(source?.endsAt));
const types = [{ label: 'Постоянный', value: 'PERMANENT' }, { label: 'Временный', value: 'TEMPORARY' }];
const contents = [{ label: 'Текст или объявление', value: 'CUSTOM' }, { label: 'Бесплатная доставка', value: 'FREE_DELIVERY' },
  { label: 'Сейчас в сезоне', value: 'SEASONAL' }, { label: 'Хиты рынка', value: 'HITS' }];
const positions = ['center', 'left center', 'right center', 'center top', 'center bottom'].map((value, index) =>
  ({ value, label: ['Центр', 'Слева', 'Справа', 'Сверху', 'Снизу'][index] }));
const images = computed(() => [
  { label: 'Без изображения · тёмный фон', value: '' },
  ...Array.from({ length: 4 }, (_, index) => ({ label: `Текущее фото ${index + 1}`, value: `/images/hero/hero-${index}.webp` })),
  ...(form.image.startsWith('/uploads/') ? [{ label: 'Загруженное изображение', value: form.image }] : []),
]);
const api = useApiClient();
const asset = useAsset();
const toast = useToast();
const busy = ref(false);
const error = ref('');
const preview = ref<PublicHomeSlide | null>(null);
const previewReason = ref('');
const previewBusy = ref(false);
const mobile = ref(true);
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
function chooseContent(content: string) {
  if (content === 'FREE_DELIVERY') { form.title = 'Бесплатная доставка от {threshold}'; form.text = 'Добавьте товары на нужную сумму. Условие проверяется при оформлении заказа.'; form.buttonLabel = 'Выбрать продукты'; form.to = '/catalog'; }
  if (content === 'SEASONAL') { form.title = 'Сейчас в сезоне'; form.text = 'Выбирайте сезонные продукты из актуального ассортимента рынка.'; form.buttonLabel = 'Сезонные товары'; form.to = '/catalog?tag=seasonal'; }
  if (content === 'HITS') { form.title = 'Хиты рынка'; form.text = 'Товары, которые чаще всего покупали в завершённых заказах.'; form.buttonLabel = 'Смотреть хиты'; form.to = '/catalog?tag=hit'; }
}
function payload(published: boolean): SlideInput {
  const start = startsAt.value ? pickupDate(startsAt.value) : null;
  const end = endsAt.value ? pickupDate(endsAt.value) : null;
  if ((startsAt.value && !start) || (endsAt.value && !end) || (start && end && end <= start))
    throw new Error('Проверьте даты: окончание должно быть позже начала.');
  if (published && form.type === 'TEMPORARY' && !end) throw new Error('Укажите окончание временной публикации.');
  return { ...form, title: form.title.trim(), text: form.text.trim(), eyebrow: form.eyebrow.trim() || null,
    buttonLabel: form.buttonLabel.trim() || null, to: form.to.trim() || null, image: form.image || null,
    published, startsAt: start?.toISOString() ?? null, endsAt: end?.toISOString() ?? null };
}
async function save(published: boolean) {
  if (busy.value) return;
  error.value = ''; busy.value = true;
  try {
    const result = await api<AdminHomeSlide>(id.value ? `/admin/home-slides/${id.value}` : '/admin/home-slides', {
      method: id.value ? 'PATCH' : 'POST', body: payload(published),
    });
    id.value = result.id; form.published = result.published;
    toast.add({ title: published ? 'Публикация сохранена' : 'Черновик сохранён' });
    emit('saved');
  } catch (cause) { error.value = apiError(cause); }
  finally { busy.value = false; }
}
async function upload(event: Event) {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  if (!file || busy.value) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    error.value = 'Выберите JPEG, PNG или WebP до 5 МБ.'; element.value = ''; return;
  }
  busy.value = true; error.value = '';
  try {
    if (!id.value) {
      const draft = await api<AdminHomeSlide>('/admin/home-slides', { method: 'POST', body: payload(false) });
      id.value = draft.id; emit('saved');
    }
    const body = new FormData(); body.append('file', file);
    const result = await api<{ image: string }>(`/admin/home-slides/${id.value}/image`, { method: 'POST', body });
    form.image = result.image;
    toast.add({ title: 'Фото загружено. Сохраните слайд, чтобы применить его.' });
    await showPreview();
  } catch (cause) { error.value = apiError(cause); }
  finally { busy.value = false; element.value = ''; }
}
async function showPreview() {
  const request = ++generation;
  previewBusy.value = true;
  try {
    const result = await api<{ slide: PublicHomeSlide | null; reason: string | null }>('/admin/home-slides/preview', { method: 'POST', body: payload(false) });
    if (request === generation) { preview.value = result.slide; previewReason.value = result.reason ?? ''; }
  } catch (cause) { if (request === generation) { preview.value = null; previewReason.value = apiError(cause); } }
  finally { if (request === generation) previewBusy.value = false; }
}
watch(() => JSON.stringify([form, startsAt.value, endsAt.value]), () => {
  if (import.meta.server) return;
  clearTimeout(timer); timer = setTimeout(() => { if (form.title.trim()) void showPreview(); }, 400);
});
onMounted(() => { if (form.title) void showPreview(); });
onBeforeUnmount(() => { generation++; clearTimeout(timer); });
</script>

<style scoped>
.slide-preview { position: relative; isolation: isolate; width: 100%; min-width: 0; min-height: 24rem; overflow: hidden; border-radius: 1rem; background: #050f1e; container-type: inline-size; }
.slide-preview--mobile { max-width: 360px; }
.slide-preview__image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.slide-preview::before { content: ''; position: absolute; inset: 0; z-index: 1; background: linear-gradient(90deg, rgb(5 15 30 / 72%), rgb(5 15 30 / 52%) 55%, rgb(5 15 30 / 18%)); }
.slide-preview__content { position: relative; z-index: 2; padding: clamp(1rem, 4cqw, 4rem); padding-bottom: 4.75rem; }
.slide-preview__label { color: var(--ui-primary); font-weight: 600; }
.slide-preview__title { margin-top: 0.75rem; color: #fff; font-size: clamp(1.75rem, 1.15rem + 2.8cqw, 3.5rem); font-weight: 700; line-height: 1.12; white-space: pre-line; overflow-wrap: anywhere; }
.slide-preview__text { margin-block: 1rem 1.5rem; color: rgb(255 255 255 / 96%); font-size: clamp(1.0625rem, 0.95rem + 0.5cqw, 1.25rem); line-height: 1.6; overflow-wrap: anywhere; }
.slide-preview__action { width: 100%; max-width: 100%; justify-content: center; min-height: 44px; white-space: normal; overflow-wrap: anywhere; }
@container (min-width: 40rem) { .slide-preview__action { width: auto; } }
@container (min-width: 64rem) { .slide-preview__content { max-width: 61.5%; } }
</style>
