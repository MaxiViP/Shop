import assert from 'node:assert/strict';
import test from 'node:test';
import { apiError } from '../app/utils/api-error.ts';

const networkMessage = 'Не удалось получить ответ сервера. Проверьте подключение к интернету.';

test('browser and server transport failures show connection advice without asking to replay the mutation', () => {
  for (const message of ['Failed to fetch', 'fetch failed', 'Load failed', 'NetworkError', 'NetworkError when attempting to fetch resource.']) {
    assert.equal(apiError(new TypeError(message)), networkMessage);
  }
});

test('ofetch transport failures hide request URLs and their query parameters', () => {
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    assert.equal(apiError(new Error(`[${method}] "/api/orders?token=private-fixture": <no response> Failed to fetch`)), networkMessage);
  }
});

test('server validation messages take priority over the transport fallback', () => {
  assert.equal(apiError({ message: 'Failed to fetch', data: { message: 'Заказ уже изменился' } }), 'Заказ уже изменился');
  assert.equal(apiError({ message: 'fetch failed', data: { message: ['Первое', 'Второе'] } }), 'Первое. Второе');
});

test('other error messages and unknown values keep their existing fallback', () => {
  assert.equal(apiError(new Error('Сначала верните позицию в сборку')), 'Сначала верните позицию в сборку');
  for (const value of [null, undefined, 'Failed to fetch', {}]) assert.equal(apiError(value), 'Не удалось выполнить действие');
});
