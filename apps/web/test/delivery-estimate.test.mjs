import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { useDeliveryStore } from '../app/stores/delivery.ts';
import { estimateAddress } from '../app/utils/delivery-estimate.ts';

const address = { id: 1, label: 'Дом', city: 'Москва', street: 'Барклая', house: '10', isDefault: true };
const quote = (price = 65_001) => ({ price, currency: 'RUB', calculatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 120_000).toISOString(), sampleWeightGrams: 5_000 });
const settle = () => new Promise(resolve => setImmediate(resolve));
function store(api) {
  globalThis.useApiClient = () => api;
  setActivePinia(createPinia());
  return useDeliveryStore();
}

test('default saved address triggers an estimate before shopping; navigation reuses it', async () => {
  const requests = [];
  const delivery = store(async (path, options) => {
    requests.push({ path, options });
    return path === '/addresses' ? [address] : quote();
  });
  await delivery.initialize(1);
  await settle();
  assert.equal(delivery.selected.id, 1);
  assert.equal(delivery.quote.price, 65_001);
  await delivery.refresh();
  assert.deepEqual(requests.map(request => request.path), ['/addresses', '/delivery/estimate']);
  assert.deepEqual(requests[1].options.body, { city: 'Москва', street: 'Барклая', house: '10', buildingPart: undefined });
  delivery.stop();
});

test('late response for a previous address cannot overwrite the new price', async () => {
  const resolvers = [];
  const delivery = store(() => new Promise(resolve => resolvers.push(resolve)));
  delivery.select(address);
  delivery.select({ ...address, house: '11' });
  resolvers[1](quote(70_000));
  await settle();
  resolvers[0](quote(10_000));
  await settle();
  assert.equal(delivery.selected.house, '11');
  assert.equal(delivery.quote.price, 70_000);
  delivery.stop();
});

test('logout clears the private address and ignores late provider and address responses', async () => {
  let resolveAddresses;
  let resolveQuote;
  const delivery = store(path => new Promise(resolve => {
    if (path === '/addresses') resolveAddresses = resolve;
    else resolveQuote = resolve;
  }));
  const initialization = delivery.initialize(1);
  delivery.select(address);
  await delivery.initialize(null);
  resolveAddresses([address]);
  resolveQuote(quote());
  await initialization;
  await settle();
  assert.equal(delivery.selected, null);
  assert.equal(delivery.quote, null);
  assert.deepEqual(delivery.addresses, []);
  assert.equal(delivery.pending, false);
  delivery.stop();
});

test('a failed refresh retains the previous estimate, marks it stale and throttles automatic retries', async () => {
  let calls = 0;
  const delivery = store(async () => {
    calls++;
    if (calls > 1) throw new Error('offline');
    return { ...quote(), expiresAt: new Date(Date.now() - 1).toISOString() };
  });
  delivery.select(address);
  await settle();
  await delivery.refresh();
  assert.equal(delivery.stale, true);
  assert.equal(delivery.quote.price, 65_001);
  assert.match(delivery.error, /Не удалось/);
  await delivery.refresh();
  assert.equal(calls, 2);
  await delivery.refresh(true);
  assert.equal(calls, 3);
  delivery.stop();
});

test('only address fields and paired coordinates go to the estimate endpoint', () => {
  assert.deepEqual(estimateAddress({ ...address, lat: 55.7, lng: 37.5, flat: 'secret', comment: 'secret' }),
    { city: 'Москва', street: 'Барклая', house: '10', buildingPart: undefined, lat: 55.7, lng: 37.5 });
  assert.equal('lat' in estimateAddress({ ...address, lat: 55.7 }), false);
});

test('changing apartment or access details retains the tariff and avoids new API requests', async () => {
  const requests = [];
  const delivery = store(async (path, options) => {
    requests.push({ path, options });
    return quote();
  });
  delivery.select({ ...address, lat: 55.7, lng: 37.5 });
  await settle();
  const firstQuote = delivery.quote;
  delivery.updateDetails({ flat: '25', entrance: '2', floor: '7', intercom: '25К', comment: 'Позвонить' });
  await settle();
  assert.equal(delivery.selected.flat, '25');
  assert.equal(delivery.selected.intercom, '25К');
  assert.strictEqual(delivery.quote, firstQuote);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].options.body, {
    city: 'Москва', street: 'Барклая', house: '10', buildingPart: undefined, lat: 55.7, lng: 37.5,
  });
  delivery.stop();
});
