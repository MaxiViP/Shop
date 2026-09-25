import assert from 'node:assert/strict';
import test from 'node:test';
import { telegramReturnTo } from '../app/utils/telegram-return.ts';
import { customerBotUrl } from '../app/utils/customer-bot-url.ts';
import { readFile } from 'node:fs/promises';

const order = '/order/11111111-1111-4111-8111-111111111111';
test('only exact local Telegram destinations survive', () => {
  for (const target of [order, '/product/apple', '/product/green-grapes', '/catalog'])
    assert.equal(telegramReturnTo(target), target);
  for (const target of [null, ['https://evil.example'], 'https://evil.example', '//evil.example',
    '/\\evil', '/%2F%2Fevil', '/product/../admin', '/product/a%2Fb',
    '/product/a?next=//evil.example', '/order/not-a-uuid'])
    assert.equal(telegramReturnTo(target), '/catalog');
});

test('customer burger link accepts only a public customer bot URL', async () => {
  const url = 'https://t.me/korzinamarket_customer_bot';
  assert.equal(customerBotUrl(url), url);
  for (const value of ['', undefined, 'http://t.me/customer_bot', 'https://evil.example/customer_bot',
    'https://t.me/korzinamarket_seller_bot', 'https://t.me/customer_bot?token=secret'])
    assert.equal(customerBotUrl(value), null);
  const header = await readFile(new URL('../app/components/app/Header.vue', import.meta.url), 'utf8');
  assert.match(header, /v-if="customerTelegramUrl"[\s\S]*?:href="customerTelegramUrl"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?Покупать в Telegram/);
  assert.doesNotMatch(header, /korzinamarket_seller_bot/);
  assert.match(header, /customerBotUrl\(useRuntimeConfig\(\)\.public\.telegramCustomerBotUrl\)/);
});
