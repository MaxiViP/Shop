import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createSSRApp, defineComponent, h, computed, ref, watch } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ts from 'typescript';
import * as delivery from '../app/utils/delivery.ts';
import * as money from '../app/utils/money.ts';
import { pickupTime } from '../app/utils/pickup.ts';
import { paymentLabels } from '../app/utils/payment.ts';

const nodeRequire = createRequire(import.meta.url);
const modules = {
  '~/utils/delivery': delivery,
  '~/utils/money': money,
  '~/utils/pickup': { pickupTime },
};
async function component(file) {
  const source = await readFile(new URL('../app/components/' + file, import.meta.url), 'utf8');
  const { descriptor } = parse(source, { filename: file });
  const compiled = compileScript(descriptor, { id: file, inlineTemplate: true });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const context = { require: id => modules[id] ?? nodeRequire(id), exports: module.exports, module,
    computed, ref, watch, useToast: () => ({ add() {} }),
  };
  new Function(...Object.keys(context), code)(...Object.values(context));
  return module.exports.default;
}
const Payment = await component('order/Payment.vue');
const Card = await component('order/Card.vue');
const FreeDelivery = await component('cart/FreeDelivery.vue');
const Costs = await component('order/Costs.vue');
const PromoDiscount = await component('order/PromoDiscount.vue');
const wrapper = defineComponent({ setup: (_, { slots }) => () => h('div', [slots.header?.(), slots.default?.()]) });
const link = defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) });
async function render(Component, props) {
  const app = createSSRApp(Component, props);
  Object.assign(app.config.globalProperties, money, { paymentLabels });
  app.component('NuxtLink', link);
  app.component('OrderCosts', Costs);
  app.component('OrderPromoDiscount', PromoDiscount);
  for (const name of ['UCard', 'UButton', 'UAlert', 'UBadge', 'UIcon', 'OrderStatus']) app.component(name, wrapper);
  return renderToString(app);
}

const order = { id: 1, publicId: 'saved-order', type: 'DELIVERY', status: 'READY',
  fulfillmentMode: 'ASAP', scheduledFor: null, deliveryAt: null, createdAt: '2026-10-01T12:00:00.000Z',
  subtotal: 30_000, finalSubtotal: 12_000, assemblyFinalizedAt: '2026-10-01T12:30:00.000Z',
  freeDeliveryApplied: true, freeDeliveryThresholdSnapshot: 20_000,
  delivery: { provider: 'YANDEX', price: 76_543 },
  payment: { status: 'AWAITING', amount: 12_000 }, paymentDetails: null,
  items: [{ productName: 'Яблоки' }],
};

for (const scenario of [
  { name: 'saved free delivery after assembly drops below the saved threshold', type: 'DELIVERY', price: 0,
    message: 'Бесплатная доставка', separatelyPaid: false },
  { name: 'saved paid delivery even when the goods total exceeds a new threshold', type: 'DELIVERY', price: 48_765,
    message: 'Доставка — 487,65 ₽. Оплачивается отдельно от товаров и услуг магазина.', separatelyPaid: true },
  { name: 'unknown carrier price with disabled free delivery', type: 'DELIVERY', price: null,
    message: 'Доставка оплачивается отдельно. Стоимость рассчитывается после сборки по адресу и тарифу перевозчика.', separatelyPaid: true },
  { name: 'pickup with its separate payment explanation', type: 'PICKUP', price: 0,
    message: 'Самовывоз — бесплатно. Оплачиваются только товары и услуги магазина.', separatelyPaid: false },
]) {
  test(scenario.name + ' agrees between payment and history', async () => {
    const saved = { ...order, type: scenario.type, deliveryPrice: scenario.price,
      freeDeliveryApplied: scenario.type === 'DELIVERY' && scenario.price === 0 };
    const before = structuredClone(saved);
    for (const Component of [Payment, Card]) {
      const html = await render(Component, { order: saved });
      assert.ok(html.includes(scenario.message), html);
      assert.equal(/оплачивается отдельно/i.test(html), scenario.separatelyPaid);
      assert.ok(!html.includes(money.money(saved.delivery.price)), 'The carrier charge is not the customer charge');
      assert.ok(!html.includes('NaN') && !html.includes('undefined'));
    }
    assert.deepEqual(saved, before, 'Presentation does not change saved financial fields');
  });
}

test('delivery amount preserves server kopecks, treats zero as free and leaves null unknown', () => {
  assert.equal(delivery.deliveryCost(0), 'Бесплатная доставка');
  assert.equal(delivery.deliveryCost(48_765), '487,65 ₽');
  assert.equal(delivery.deliveryCost(1), '0,01 ₽');
  assert.equal(delivery.deliveryCost(null), 'Рассчитывается после сборки');
});

const quote = { enabled: true, threshold: 20_000, remaining: 1, progress: 99, eligible: false, price: null, total: null };
test('cart shows the exact server remainder and progress below the free-delivery threshold', async () => {
  const html = await render(FreeDelivery, { quote });
  assert.ok(html.includes('До бесплатной доставки осталось 0,01 ₽'));
  assert.match(html, /aria-valuenow="99"/);
  assert.ok(!html.includes('Бесплатная доставка'));
});

test('cart announces free delivery for an eligible server quote', async () => {
  const html = await render(FreeDelivery, { quote: { ...quote, remaining: 0, progress: 100, eligible: true, price: 0, total: 20_000 } });
  assert.ok(html.includes('Бесплатная доставка'));
  assert.ok(!html.includes('осталось') && !html.includes('оплачивается отдельно'));
});

test('cart hides promotion progress when disabled or when the server amount is unknown', async () => {
  for (const changes of [{ enabled: false }, { remaining: null }]) {
    const html = await render(FreeDelivery, { quote: { ...quote, ...changes } });
    assert.ok(!html.includes('free-delivery') && !html.includes('бесплатн'));
  }
});
