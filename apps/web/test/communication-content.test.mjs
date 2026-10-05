import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
test('one brand hero and the customer explanation describe the current market flow', async () => {
  const [hero, header, page, sitemap] = await Promise.all([
    read('app/components/home/HeroCarousel.vue'), read('app/components/app/Header.vue'),
    read('app/pages/how-it-works.vue'), read('server/routes/sitemap.xml.get.ts'),
  ]);
  assert.match(hero, /Не просто доставка\.<br>Аутентичный поход на рынок — без потери времени\./);
  assert.match(hero, /Продавец показывает продукты прямо с прилавка/);
  assert.match(header, /to="\/how-it-works"/); assert.match(header, /<span>Как это работает<\/span>/);
  assert.match(page, /Аутентичный рынок — где бы вы ни находились/);
  assert.match(page, /Фото прилавка/); assert.match(page, /Самовывоз с рынка/); assert.match(page, /Сборка и очередь/);
  assert.match(page, /Заказ ко времени/); assert.match(page, /site.delivery.priorityText/); assert.match(page, /site.delivery.pricingText/);
  assert.doesNotMatch(page, /live video|smart glasses|Специфика работы/);
  assert.match(sitemap, /"\/how-it-works"/);
});

test('load profiles belong to an ADMIN page with visible navigation from Settings and dashboard', async () => {
  const [page, settings, dashboard, staff] = await Promise.all([
    read('app/pages/admin/queue.vue'), read('app/pages/admin/settings.vue'),
    read('app/pages/admin/index.vue'), read('app/pages/staff/orders/index.vue'),
  ]);
  assert.match(page, /layout: 'admin', middleware: 'admin'/);
  assert.match(page, /Обычный режим/); assert.match(page, /Пиковый режим/); assert.match(page, /Одновременно работающих сборщиков/);
  assert.match(page, /state.effective.assemblyConcurrency/); assert.match(page, /state.upcoming/); assert.match(page, /slot.reserved/);
  assert.match(settings, /to="\/admin\/queue"/); assert.match(dashboard, /to="\/admin\/queue"/);
  assert.doesNotMatch(staff, /peakAssemblyConcurrency|peakModeStart|\/admin\/settings|slotCapacity/);
});
