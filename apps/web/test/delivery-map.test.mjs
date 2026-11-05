import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, reactive, ref, watch, nextTick } from 'vue';
import { deliveryAddressKey } from '../app/utils/delivery-estimate.ts';
import { formatAddress } from '../app/utils/address.ts';

async function script(file) {
  const source = await readFile(new URL('../app/components/delivery/' + file, import.meta.url), 'utf8');
  const setup = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import [^\r\n]*(?:\r?\n|$)/gm, '');
  return ts.transpileModule(setup, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const mapScript = await script('Map.client.vue');
const calculatorScript = await script('Calculator.vue');
const address = { city: 'Москва', street: 'Барклая', house: '10', buildingPart: 'стр. 1' };
const settle = () => new Promise(resolve => setImmediate(resolve));
const result = (overrides = {}) => ({
  geometry: { getCoordinates: () => [55.742, 37.501] },
  properties: { get: () => 'exact' },
  getLocalities: () => ['Москва'], getAdministrativeAreas: () => [],
  getThoroughfare: () => 'Барклая', getPremiseNumber: () => '10', ...overrides,
});

async function fixture(t, saved = null) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const props = reactive({ address: saved });
  const stops = [], unmount = [], picked = [], centers = [], markers = [], queries = [];
  const events = {}, searchEvents = {};
  const search = { events: { add: (name, handler) => { searchEvents[name] = handler; } },
    results: [], getResultsArray() { return this.results; }, getResult: async () => result() };
  let mount, destroyed = false;
  const api = {
    Map: class {
      events = { add: (name, handler) => { events[name] = handler; } };
      controls = { get: () => search };
      geoObjects = { add: marker => markers.push(marker), remove: marker => markers.splice(markers.indexOf(marker), 1) };
      setCenter(coordinates, zoom) { centers.push({ coordinates, zoom }); return Promise.resolve(); }
      destroy() { destroyed = true; }
    },
    Placemark: class {
      constructor(coordinates) { this.coordinates = coordinates; }
      geometry = { setCoordinates: coordinates => { this.coordinates = coordinates; } };
    },
    geocode: async (query, options) => { queries.push({ query, options }); return { geoObjects: { get: () => result() } }; },
  };
  const context = { ref, watch: (...args) => { const stop = watch(...args); stops.push(stop); },
    defineProps: () => props, defineEmits: () => (name, value) => picked.push({ name, value }),
    useRuntimeConfig: () => ({ public: { yandexMapsKey: 'fixture', yandexSuggestKey: '' } }),
    loadDeliveryMap: async () => api, deliveryAddressKey, formatAddress,
    onMounted: callback => { mount = callback; }, onBeforeUnmount: callback => unmount.push(callback),
  };
  const state = new Function(...Object.keys(context), mapScript + '\nelement.value = {}; return { pending, error, hint };')(...Object.values(context));
  const close = () => { unmount.splice(0).forEach(fn => fn()); stops.splice(0).forEach(stop => stop()); };
  t.after(close);
  await mount();
  await settle();
  return { ...state, props, api, search, picked, centers, markers, queries, close,
    get destroyed() { return destroyed; },
    choose(value) { search.results = [value]; searchEvents.resultselect({ get: () => 0 }); },
    select() { search.results = []; searchEvents.resultselect({ get: () => 0 }); },
    click(coordinates) { events.click({ get: () => coordinates }); },
    failSearch() { searchEvents.error(); },
  };
}

test('manual typing debounces geocoding, includes the building and never rewrites the form', async t => {
  const f = await fixture(t);
  assert.equal(f.pending.value, false);
  assert.equal(f.markers.length, 0, 'Moscow center is not a selected delivery address');
  f.props.address = { ...address, house: '1' };
  t.mock.timers.tick(300);
  f.props.address.house = '10';
  t.mock.timers.tick(599);
  await settle();
  assert.equal(f.queries.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(f.queries, [{ query: 'Москва, Барклая, д. 10, стр. 1', options: { results: 1 } }]);
  assert.deepEqual(f.markers[0].coordinates, [55.742, 37.501]);
  assert.equal(f.centers.at(-1).zoom, 16);
  assert.deepEqual(f.picked, []);
  assert.deepEqual({ ...f.props.address }, address);
  f.props.address.flat = '25';
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(f.queries.length, 1, 'Apartment changes do not geocode the house again');
  f.props.address.house = '';
  assert.equal(f.markers.length, 0, 'Incomplete address removes the old marker immediately');
  assert.equal(f.pending.value, false);
});

test('opening or changing a saved address shows its coordinates without another geocoder call', async t => {
  const f = await fixture(t, { ...address, lat: 55.7, lng: 37.5 });
  assert.deepEqual(f.markers[0].coordinates, [55.7, 37.5]);
  f.props.address = { ...address, house: '11', lat: 55.8, lng: 37.6 };
  assert.deepEqual(f.markers[0].coordinates, [55.8, 37.6]);
  assert.equal(f.queries.length, 0);
  assert.deepEqual(f.picked, []);
});

test('a street search moves the map and asks for a house without blocking further selection', async t => {
  const f = await fixture(t);
  f.choose(result({ getPremiseNumber: () => '' }));
  await settle();
  assert.equal(f.pending.value, false);
  assert.equal(f.error.value, '');
  assert.match(f.hint.value, /Уточните номер дома/);
  assert.equal(f.centers.at(-1).zoom, 14);
  assert.equal(f.markers.length, 0);
  assert.equal(f.picked.length, 0);
  f.choose(result());
  await settle();
  assert.equal(f.hint.value, '');
  assert.equal(f.picked.length, 1);
  assert.deepEqual(f.picked[0], { name: 'picked', value: { city: 'Москва', street: 'Барклая', house: '10', lat: 55.742, lng: 37.501 } });
});

test('an unresolved or synchronously failing search stops loading and can be retried', async t => {
  const f = await fixture(t);
  f.search.getResult = () => new Promise(() => {});
  f.select();
  await settle();
  assert.equal(f.pending.value, true);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(f.pending.value, false);
  assert.match(f.error.value, /Ручной ввод остаётся доступен/);
  f.search.getResult = () => { throw new Error('synchronous Yandex failure'); };
  f.select();
  await settle();
  assert.equal(f.pending.value, false);
  f.choose(result());
  await settle();
  assert.equal(f.error.value, '');
  assert.equal(f.picked.length, 1);
});

test('manual edits cancel old map selections and late responses cannot change the destination', async t => {
  const f = await fixture(t);
  let resolveOld;
  f.search.getResult = () => new Promise(resolve => { resolveOld = resolve; });
  f.select();
  await settle();
  f.props.address = address;
  assert.equal(f.pending.value, false);
  t.mock.timers.tick(600);
  await settle();
  resolveOld(result({ geometry: { getCoordinates: () => [50, 30] } }));
  await settle();
  assert.deepEqual(f.markers[0].coordinates, [55.742, 37.501]);
  assert.equal(f.picked.length, 0);
  assert.equal(f.pending.value, false);
});

test('an approximate manual match does not show a different house as the delivery point', async t => {
  const f = await fixture(t);
  f.api.geocode = async () => ({ geoObjects: { get: () => result({ properties: { get: () => 'near' } }) } });
  f.props.address = address;
  t.mock.timers.tick(600);
  await settle();
  assert.equal(f.pending.value, false);
  assert.match(f.error.value, /точный дом/);
  assert.equal(f.markers.length, 0);
  assert.deepEqual(f.props.address, address);
});

test('map clicks resolve a house; errors and unmount cancel pending work', async t => {
  const f = await fixture(t);
  f.click([55.742, 37.501]);
  await settle();
  assert.deepEqual(f.queries[0], { query: [55.742, 37.501], options: { results: 1, kind: 'house' } });
  assert.equal(f.picked.length, 1);
  let resolveOld;
  f.search.getResult = () => new Promise(resolve => { resolveOld = resolve; });
  f.select();
  await settle();
  f.failSearch();
  assert.equal(f.pending.value, false);
  assert.match(f.error.value, /Поиск временно недоступен/);
  f.close();
  resolveOld(result());
  t.mock.timers.tick(20_000);
  await settle();
  assert.equal(f.destroyed, true);
  assert.equal(f.picked.length, 1);
});

test('calculator passes live fields to the map and discards coordinates as soon as a house changes', async t => {
  const saved = { ...address, id: 1, lat: 55.7, lng: 37.5 };
  const delivery = reactive({ selected: saved, select(value) { this.selected = value; }, error: '' });
  const stops = [];
  t.after(() => stops.forEach(stop => stop()));
  const context = { ref, computed, reactive, watch: (...args) => { const stop = watch(...args); stops.push(stop); },
    useDeliveryStore: () => delivery, useCartStore: () => ({}), useRuntimeConfig: () => ({ public: { yandexMapsKey: 'test' } }),
  };
  const f = new Function(...Object.keys(context), calculatorScript + '\nreturn { form, mapAddress, calculate };')(...Object.values(context));
  assert.equal(f.mapAddress.value.lat, 55.7);
  f.form.house = '11';
  assert.equal(f.mapAddress.value.house, '11');
  assert.equal(f.mapAddress.value.lat, undefined);
  f.calculate();
  await nextTick();
  assert.equal(delivery.selected.house, '11');
  assert.equal(delivery.selected.lat, undefined);
  delivery.select({ ...saved, lat: 55.8 });
  await nextTick();
  assert.equal(f.mapAddress.value.lat, 55.8, 'Coordinates react even when the address text stays the same');
});
