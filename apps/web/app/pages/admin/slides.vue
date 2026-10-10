<template>
  <section class="slides">
    <div class="slides__head">
      <h2 class="text-2xl font-semibold">Слайды главной</h2>
      <UButton icon="i-lucide-plus" @click="edit()">Создать слайд</UButton>
    </div>
    <p class="text-muted">Перетаскивайте за значок или используйте стрелки. Приоритетный опубликованный слайд показывается первым. Все даты — по Москве.</p>
    <UAlert v-if="error" color="error" title="Не удалось загрузить слайды" :actions="[{ label: 'Повторить', onClick: () => refresh() }]" />
    <p v-if="pending">Загрузка…</p>
    <p v-else-if="!slides.length">Слайдов пока нет. Создайте первый слайд и сохраните черновик.</p>
    <div class="slides__list">
      <UCard v-for="(slide, index) in slides" :key="slide.id" @dragover.prevent @drop.prevent="drop(slide.id)">
        <div class="slides__row">
          <button class="slides__drag" type="button" draggable="true" :disabled="busy" aria-label="Перетащить слайд" @dragstart="startDrag($event, slide.id)" @dragend="dragId = null"><UIcon name="i-lucide-grip-vertical" /></button>
          <img v-if="slide.image" class="slides__image" :src="asset(slide.image)" alt="">
          <div class="slides__info">
            <h3 class="font-semibold">{{ slide.title }}</h3>
            <div class="slides__meta">
              <UBadge color="neutral" variant="soft">{{ slide.type === 'PERMANENT' ? 'Постоянный' : 'Временный' }}</UBadge>
              <UBadge :color="slide.status === 'ACTIVE' ? 'success' : 'neutral'" variant="soft">{{ statusLabels[slide.status] }}</UBadge>
              <UBadge v-if="slide.published && slide.priority" color="warning" variant="soft">Показывать первым</UBadge>
              <span>Порядок: {{ slide.sortOrder }}</span>
            </div>
            <p class="text-sm text-muted">{{ slide.startsAt ? pickupTime(slide.startsAt) : 'Без даты начала' }} — {{ slide.endsAt ? pickupTime(slide.endsAt) : 'Без даты окончания' }}</p>
            <p v-if="slide.content === 'FREE_DELIVERY'" class="text-sm text-muted">
              Показывается при включённой бесплатной доставке. Порог берётся из
              <NuxtLink to="/admin/settings" class="underline">настроек магазина</NuxtLink>.
            </p>
          </div>
          <div class="slides__actions">
            <UButton icon="i-lucide-arrow-up" variant="ghost" color="neutral" :disabled="busy || index === 0" aria-label="Выше" @click="move(index, -1)" />
            <UButton icon="i-lucide-arrow-down" variant="ghost" color="neutral" :disabled="busy || index === slides.length - 1" aria-label="Ниже" @click="move(index, 1)" />
            <UButton icon="i-lucide-pencil" variant="soft" :disabled="busy" aria-label="Редактировать слайд" @click="edit(slide)" />
            <UButton icon="i-lucide-copy" variant="ghost" color="neutral" :disabled="busy" aria-label="Скопировать слайд" @click="copy(slide)" />
            <UButton :icon="slide.active ? 'i-lucide-eye-off' : 'i-lucide-eye'" variant="ghost" color="neutral" :disabled="busy" :aria-label="slide.active ? 'Отключить слайд' : 'Включить слайд'" @click="toggle(slide)" />
            <UButton icon="i-lucide-trash-2" variant="ghost" color="error" :disabled="busy" aria-label="Удалить слайд" @click="removeTarget = slide" />
          </div>
        </div>
      </UCard>
    </div>
    <UModal v-model:open="editorOpen" :title="selected ? 'Редактировать слайд' : 'Новый слайд'" description="Текст, изображение и период показа на главной странице" :ui="{ content: 'sm:max-w-5xl' }">
      <template #body><AdminSlideForm v-if="editorOpen" :key="selected?.id ?? 'new'" :slide="selected" :next-order="nextOrder" @saved="refresh" /></template>
    </UModal>
    <AdminConfirm :open="!!removeTarget" :busy="busy" title="Удалить слайд?" :description="removeTarget?.title" @update:open="value => { if (!value) removeTarget = null; }" @confirm="remove" />
  </section>
</template>

<script setup lang="ts">
import type { AdminHomeSlide, SlideStatus } from '~/types/home-slide';
import { pickupTime } from '~/utils/pickup';
definePageMeta({ layout: 'admin', middleware: 'admin' });
const { data: slides, pending, error, refresh } = await useApi<AdminHomeSlide[]>('/admin/home-slides', { default: () => [] });
const statusLabels: Record<SlideStatus, string> = { DRAFT: 'Черновик', SCHEDULED: 'Запланирован', ACTIVE: 'Активен', ENDED: 'Завершён', DISABLED: 'Отключён' };
const nextOrder = computed(() => Math.min(1_000_000, Math.max(-1, ...slides.value.map(slide => slide.sortOrder)) + 1));
const selected = ref<AdminHomeSlide>();
const editorOpen = ref(false);
const removeTarget = ref<AdminHomeSlide | null>(null);
const busy = ref(false);
const dragId = ref<number | null>(null);
const api = useApiClient();
const asset = useAsset();
const toast = useToast();
function edit(slide?: AdminHomeSlide) { selected.value = slide; editorOpen.value = true; }
async function action(run: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  try { await run(); await refresh(); }
  catch (cause) { toast.add({ title: apiError(cause), color: 'error' }); }
  finally { busy.value = false; }
}
async function copy(slide: AdminHomeSlide) {
  await action(async () => { const result = await api<AdminHomeSlide>(`/admin/home-slides/${slide.id}/copy`, { method: 'POST' }); edit(result); });
}
const toggle = (slide: AdminHomeSlide) => action(() => api(`/admin/home-slides/${slide.id}`, { method: 'PATCH', body: { active: !slide.active } }));
async function remove() {
  if (!removeTarget.value) return;
  const id = removeTarget.value.id;
  await action(async () => { await api(`/admin/home-slides/${id}`, { method: 'DELETE' }); removeTarget.value = null; });
}
const reorder = (ids: number[]) => action(() => api('/admin/home-slides/reorder', { method: 'POST', body: { ids } }));
function move(index: number, direction: number) {
  const ids = slides.value.map(slide => slide.id), target = index + direction;
  if (target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target]!, ids[index]!]; void reorder(ids);
}
function startDrag(event: DragEvent, id: number) { dragId.value = id; event.dataTransfer?.setData('text/plain', String(id)); }
function drop(target: number) {
  const source = dragId.value; dragId.value = null;
  if (busy.value || source === null || source === target) return;
  const ids = slides.value.map(slide => slide.id).filter(id => id !== source);
  ids.splice(ids.indexOf(target), 0, source); void reorder(ids);
}
useOrderPolling(refresh, () => 60_000);
</script>

<style scoped>
.slides { display: grid; gap: 1rem; min-width: 0; }
.slides__head, .slides__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
.slides__head { justify-content: space-between; }
.slides__list { display: grid; gap: 0.75rem; }
.slides__row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; min-width: 0; }
.slides__drag { display: grid; place-items: center; width: 2rem; min-height: 44px; cursor: grab; }
.slides__image { width: 5rem; height: 4rem; object-fit: cover; border-radius: 0.5rem; }
.slides__info { flex: 1 1 15rem; min-width: 0; overflow-wrap: anywhere; }
.slides__meta { margin-block: 0.375rem; font-size: 0.75rem; }
.slides__actions { display: flex; flex-wrap: wrap; gap: 0.125rem; }
.slides__actions :deep(button) { min-width: 44px; min-height: 44px; }
</style>
