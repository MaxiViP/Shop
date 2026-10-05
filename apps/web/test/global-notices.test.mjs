import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createNoticeDelivery } from '../app/utils/order-notices.ts';

const event = (id, kind = 'CHAT_MESSAGE') => ({ id, kind, orderId: 21, title: 'Заказ №21',
  to: `/order/public?chatMessage=${id}#order-chat`, createdAt: '2026-10-05T12:00:00.000Z' });
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
function fixture(saved = storage(), exclusive) {
  const state = { feed: { scope: 'u:1:USER', events: [event(1)], hasMore: false }, shown: [], seen: [],
    failSeen: false, dismissed: 0, requests: 0 };
  const delivery = createNoticeDelivery({
    storage: saved, exclusive,
    fetch: async () => { state.requests++; return state.feed; },
    show: notice => state.shown.push(notice),
    acknowledge: async ids => { state.seen.push(ids); if (state.failSeen) throw new Error('Offline'); },
    dismiss: () => { state.dismissed++; },
  });
  return { state, delivery };
}

test('poll retries show each ID once, acknowledge duplicates and retain exact click targets', async () => {
  const { state, delivery } = fixture();
  state.feed.events = [event(1), event(1), event(2, 'CHAT_IMAGE_REVISION')];
  await delivery.poll(); await delivery.poll();
  assert.deepEqual(state.shown.map(event => event.id), [1, 2]);
  assert.deepEqual(state.seen, [[1, 2], [1, 2]]);
  assert.equal(state.shown[1].to, '/order/public?chatMessage=2#order-chat');
});

test('seen failure followed by reload/reconnect retries acknowledgment without repeating displayed toasts', async () => {
  const saved = storage();
  const first = fixture(saved);
  first.state.failSeen = true;
  await assert.rejects(first.delivery.poll(), /Offline/);
  const reloaded = fixture(saved);
  reloaded.state.feed.events = [event(1), event(2)];
  await reloaded.delivery.poll();
  assert.deepEqual(reloaded.state.shown.map(event => event.id), [2]);
  assert.deepEqual(reloaded.state.seen, [[1, 2]]);
});

function lock() {
  let pending = Promise.resolve();
  return work => {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  };
}

test('two initialized tabs display a batch once even when the first seen request fails', async () => {
  const saved = storage(), exclusive = lock();
  const first = fixture(saved, exclusive), second = fixture(saved, exclusive);
  first.state.feed.events = second.state.feed.events = [];
  await Promise.all([first.delivery.poll(), second.delivery.poll()]);
  first.state.feed.events = second.state.feed.events = [event(1), event(2)];
  first.state.failSeen = true;
  const results = await Promise.allSettled([first.delivery.poll(), second.delivery.poll()]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled']);
  assert.deepEqual([...first.state.shown, ...second.state.shown].map(event => event.id), [1, 2]);
  assert.deepEqual(second.state.seen, [[1, 2]]);
});

test('tabs without Web Locks refresh shared shown IDs on each poll', async () => {
  const saved = storage(), first = fixture(saved), second = fixture(saved);
  first.state.feed.events = second.state.feed.events = [];
  await Promise.all([first.delivery.poll(), second.delivery.poll()]);
  first.state.feed.events = second.state.feed.events = [event(1)];
  await first.delivery.poll(); await second.delivery.poll();
  assert.equal(first.state.shown.length + second.state.shown.length, 1);
});

test('exclusive polling uses server seen state when storage is blocked', async () => {
  const exclusive = lock(), shown = [];
  let seen = false;
  const options = { exclusive, storage: { getItem() { throw Error('Blocked'); }, setItem() { throw Error('Blocked'); } },
    fetch: async () => ({ scope: 'u:1:USER', events: seen ? [] : [event(1)], hasMore: false }),
    show: notice => shown.push(notice.id), acknowledge: async () => { seen = true; }, dismiss() {},
  };
  await Promise.all([createNoticeDelivery(options).poll(), createNoticeDelivery(options).poll()]);
  assert.deepEqual(shown, [1]);
});

test('logout while waiting for another tab cannot fetch or display the previous session', async () => {
  let release, requests = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const delivery = createNoticeDelivery({ storage: storage(), exclusive: async work => { await waiting; await work(); },
    fetch: async () => { requests++; return { scope: 'u:1:USER', events: [event(1)], hasMore: false }; },
    acknowledge: async () => assert.fail('Stale acknowledgment'), show: () => assert.fail('Stale toast'), dismiss() {},
  });
  const poll = delivery.poll(); delivery.reset(); release(); await poll;
  assert.equal(requests, 0);
});

test('a tab hidden while the request runs retains the event for visible catch-up', async () => {
  let visible = true, release, requests = 0;
  const shown = [], seen = [];
  const pending = new Promise(resolve => { release = resolve; });
  const delivery = createNoticeDelivery({ storage: storage(), visible: () => visible,
    fetch: () => { requests++; return pending; }, show: event => shown.push(event.id),
    acknowledge: async ids => seen.push(ids), dismiss() {},
  });
  const poll = delivery.poll(); visible = false;
  release({ scope: 'u:1:USER', events: [event(1)], hasMore: false }); await poll;
  assert.deepEqual(shown, []); assert.deepEqual(seen, []);
  await delivery.poll(); assert.equal(requests, 1);
  visible = true; await delivery.poll();
  assert.deepEqual(shown, [1]); assert.deepEqual(seen, [[1]]);
});

test('catch-up accepts a late lower ID and subsequent batches without a maximum ID cursor gap', async () => {
  const { state, delivery } = fixture();
  state.feed = { ...state.feed, events: [event(9), event(10)], hasMore: true };
  await delivery.poll();
  state.feed = { ...state.feed, events: [event(3), event(11)], hasMore: false };
  await delivery.poll();
  assert.deepEqual(state.shown.map(event => event.id), [9, 10, 3, 11]);
});

test('account/guest scope change dismisses old toasts and keeps independent seen IDs', async () => {
  const { state, delivery } = fixture();
  await delivery.poll();
  state.feed.scope = 'g:guest'; await delivery.poll();
  state.feed.scope = 'u:1:USER'; await delivery.poll();
  assert.deepEqual(state.shown.map(event => event.id), [1, 1]);
  assert.equal(state.dismissed, 3);
  delivery.reset();
  state.feed = { scope: null, events: [], hasMore: false }; await delivery.poll();
  assert.equal(state.dismissed, 4);
});

test('overlapping polls and stale responses after logout/unmount cannot emit or mark a toast seen', async () => {
  let release, calls = 0;
  const shown = [], seen = [];
  const delivery = createNoticeDelivery({ storage: storage(), dismiss() {}, show: e => shown.push(e),
    acknowledge: async ids => seen.push(ids),
    fetch: () => { calls++; return new Promise(resolve => { release = resolve; }); },
  });
  const first = delivery.poll(); await delivery.poll();
  assert.equal(calls, 1);
  delivery.reset(); release({ scope: 'u:1:USER', events: [event(1)], hasMore: false }); await first;
  assert.deepEqual(shown, []); assert.deepEqual(seen, []);
});

test('disabled local storage keeps in-memory dedupe and successful server acknowledgment', async () => {
  const { state, delivery } = fixture({ getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } });
  await delivery.poll(); await delivery.poll();
  assert.equal(state.shown.length, 1); assert.equal(state.seen.length, 2);
});

test('the app owns polling on all routes and short closeable accessible toasts use existing Nuxt UI', async () => {
  const [app, component, css] = await Promise.all([
    readFile(new URL('../app/app.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/app/OrderNotices.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/assets/css/main.css', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /<AppOrderNotices\s*\/>/);
  assert.match(app, /max: 2/);
  assert.match(component, /useToast\(\)/);
  assert.match(component, /duration: 4500, close: true/);
  assert.match(component, /navigateTo\(event\.to\)/);
  assert.match(component, /label: 'Открыть', to: event\.to/);
  for (const name of ['visibilitychange', 'focus', 'online']) assert.ok(component.includes(`'${name}'`));
  assert.match(component, /document\.visibilityState !== 'visible'/);
  assert.match(component, /query: \{ limit: 2 \}/);
  assert.match(component, /navigator\.locks\.request\('korzina:order-notices', work\)/);
  assert.match(component, /visible: \(\) => active && document\.visibilityState === 'visible'/);
  assert.equal((component.match(/timeout: 10000/g) ?? []).length, 2);
  assert.match(css, /\.order-toasts[\s\S]*var\(--safe-top\)/);
  assert.doesNotMatch(component, /route\.path|WebSocket|EventSource/);
});
