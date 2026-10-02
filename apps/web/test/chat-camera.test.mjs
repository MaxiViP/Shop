import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chatCameraConstraints, chatCameraError } from '../app/utils/chat-camera.ts';

test('camera explicitly requests rear video, while gallery has no capture hint', async () => {
  assert.equal(chatCameraConstraints.video.facingMode.ideal, 'environment');
  assert.equal(chatCameraConstraints.audio, false);
  const chat = await readFile(new URL('../app/components/order/Chat.vue', import.meta.url), 'utf8');
  assert.match(chat, /<OrderCamera/);
  assert.doesNotMatch(chat, /capture="environment"/);
  assert.match(chat, /photoInput.*type="file"/);
});

test('permission and unsupported camera errors offer an explicit gallery fallback', () => {
  assert.match(chatCameraError(new DOMException('', 'NotAllowedError')), /Доступ к камере запрещён/);
  assert.match(chatCameraError(new DOMException('', 'NotFoundError')), /Камера не найдена/);
  assert.match(chatCameraError(null), /Выберите «Фото»/);
});
