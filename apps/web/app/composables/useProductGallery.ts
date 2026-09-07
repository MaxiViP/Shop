import { computed, ref, watch } from "vue";

interface GalleryImage {
  url: string;
  alt: string | null;
}

export function useProductGallery(images: () => readonly GalleryImage[]) {
  const selected = ref(0);
  const current = computed(
    () => images()[selected.value] ?? images()[0] ?? null,
  );
  const hasThumbnails = computed(() => images().length > 1);
  watch(images, () => {
    selected.value = 0;
  });
  function select(index: number) {
    if (Number.isInteger(index) && index >= 0 && index < images().length)
      selected.value = index;
  }
  return { selected, current, hasThumbnails, select };
}
