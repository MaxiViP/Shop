export const MAX_CHAT_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_PHOTO_PIXELS = 60_000_000;
const MAX_CHAT_PHOTO_SIDE = 4096;

export function isHeicPhoto(file: Pick<File, "name" | "type">) {
  if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) return false;
  return ["image/heic", "image/heif"].includes(file.type) || /\.hei[cf]$/i.test(file.name);
}

export function chatPhotoError(file: Pick<File, "type" | "size">) {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > MAX_CHAT_PHOTO_BYTES
  )
    return "Разрешены JPEG, PNG и WebP до 20 МБ. HEIC/HEIF можно выбрать для подготовки.";
  return "";
}

export async function prepareChatPhoto(file: File, signal?: AbortSignal): Promise<File> {
  if (!isHeicPhoto(file)) {
    const error = chatPhotoError(file);
    if (error) throw new Error(error);
    return file;
  }
  if (file.size > MAX_CHAT_PHOTO_BYTES)
    throw new Error("Максимальный размер фото — 20 МБ.");

  signal?.throwIfAborted();
  const image = new Image();
  const url = URL.createObjectURL(file);
  const abort = () => { image.src = ""; };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    image.src = url;
    try {
      await image.decode();
    } catch {
      signal?.throwIfAborted();
      throw new Error("Не удалось открыть HEIC/HEIF в этом браузере. Экспортируйте фото в JPEG или WebP и выберите его снова.");
    }
    signal?.throwIfAborted();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height || width * height > MAX_CHAT_PHOTO_PIXELS)
      throw new Error("Размер фото превышает 60 мегапикселей.");
    const scale = Math.min(1, MAX_CHAT_PHOTO_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Не удалось подготовить HEIC/HEIF. Попробуйте JPEG или WebP.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      // HTMLImageElement applies HEIC orientation before drawing in Safari.
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.src = "";
      const encode = (quality: number) => new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Не удалось подготовить HEIC/HEIF. Попробуйте JPEG или WebP.")),
          "image/jpeg", quality,
        ),
      );
      let blob = await encode(0.92);
      signal?.throwIfAborted();
      if (blob.size > MAX_CHAT_PHOTO_BYTES) blob = await encode(0.82);
      signal?.throwIfAborted();
      if (blob.type !== "image/jpeg" || blob.size > MAX_CHAT_PHOTO_BYTES)
        throw new Error("Не удалось уложить фото в 20 МБ. Выберите JPEG или WebP меньшего размера.");
      return new File([blob], "photo.jpg", { type: "image/jpeg" });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

export function chatRequest(text: string, file: File | null, evidence = false, issueId?: number, requestId?: string) {
  const value = text.trim();
  if (!file) return { path: "/messages", body: { text: value } };
  const body = new FormData();
  body.append("text", value);
  if (evidence) body.append("evidence", "true");
  if (issueId) body.append("issueId", String(issueId));
  if (requestId) body.append("requestId", requestId);
  body.append("file", file);
  return { path: "/messages/image", body };
}
