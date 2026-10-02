import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('only customer and staff chat image uploads receive the 21 MiB private streaming route', async () => {
  const config = await readFile(new URL('../../../deploy/nginx.conf', import.meta.url), 'utf8');
  const location = config.match(/location ~ "([^"]+)" \{([\s\S]*?)\n {4}\}/);
  assert.ok(location);
  const route = new RegExp(location[1]);
  const order = '11111111-1111-4111-8111-111111111111';
  for (const path of [
    `/api/orders/${order}/messages/image`,
    `/api/orders/${order}/messages/42/revisions`,
    '/api/staff/orders/21/messages/image',
    '/api/staff/orders/21/messages/42/revisions',
  ]) assert.equal(route.test(path), true, path);
  for (const path of [
    '/api/orders', '/api/products', `/api/orders/${order}/messages`,
    `/api/orders/${order}/messages/42/image`, '/api/staff/orders/21/messages/42/read',
  ]) assert.equal(route.test(path), false, path);
  for (const directive of [
    'client_max_body_size 21m;', 'proxy_request_buffering off;',
    'proxy_cache off;', 'proxy_hide_header Cache-Control;',
    'add_header Cache-Control "no-store" always;',
  ]) assert.ok(location[2].includes(directive), directive);
  assert.match(config, /client_max_body_size 6m;/);
});
