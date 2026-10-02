export const chatCameraConstraints: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
};

export function chatCameraError(cause: unknown) {
  const name = cause instanceof Error ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return 'Доступ к камере запрещён. Разрешите камеру для этого сайта или выберите «Фото».';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Камера не найдена. Выберите «Фото» из галереи.';
  if (name === 'NotReadableError')
    return 'Камера занята другим приложением. Закройте его или выберите «Фото».';
  return 'Не удалось открыть камеру в этом браузере. Выберите «Фото» из галереи.';
}
