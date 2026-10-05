import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { ref, reactive, toRefs, nextTick } from 'vue';
import * as messages from '../app/utils/chat-messages.ts';
import * as photo from '../app/utils/chat-photo.ts';
import * as focus from '../app/utils/chat-focus.ts';
import { drawMarkup, markupOutline } from '../app/utils/chat-markup.ts';
import { telegramReturnTo } from '../app/utils/telegram-return.ts';

const source = await readFile(new URL('../app/components/order/Chat.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const entry = (id, changes = {}) => ({ id, authorType: 'SELLER', recipient: 'customer', text: `Сообщение ${id}`,
  image: false, imageExpired: false, imageRevision: 0, revisionText: null, revisionActor: null, revisionAt: null,
  createdAt: `2026-10-05T10:00:${String(id % 60).padStart(2, '0')}Z`, ...changes });

// Exercise the production SFC's polling/focus/read functions with controlled viewport geometry.
// API access and real image persistence are covered by the PostgreSQL suite.
function harness(t, initial, { readThrough = 0, query = {}, hash = '' } = {}) {
  const state = { rows: [...initial], revisions: [], readThrough, revisionThrough: 0, calls: [], focused: null, polls: [] };
  const callbacks = [];
  let chat;
  const firstMessage = () => state.rows.find(row => row.id > state.readThrough && focus.counterpartMessage(row, false)) ?? null;
  const firstRevision = () => state.revisions.find(row => row.id > state.revisionThrough) ?? null;
  const page = (query) => {
    let rows = state.rows;
    if (query.around) rows = rows.filter(row => row.id >= query.around).slice(0, 30);
    else if (query.after) rows = rows.filter(row => row.id > query.after).slice(0, 30);
    else if (query.before) rows = rows.filter(row => row.id < query.before).slice(-30);
    else rows = rows.slice(-30);
    return { messages: rows, revisions: state.rows.filter(row => row.image).map(row => ({ ...row })),
      unreadMessage: firstMessage(), unreadRevision: firstRevision(), readThrough: state.readThrough,
      hasMore: state.rows.some(row => row.id < rows[0]?.id) };
  };
  const api = async (path, options = {}) => {
    state.calls.push({ path, options });
    if (path.endsWith('/read')) {
      state.readThrough = Math.max(state.readThrough, options.body.through);
      state.revisionThrough = options.body.revisionThrough ?? state.revisionThrough;
      return { readThrough: state.readThrough, unreadMessage: firstMessage(), unreadRevision: firstRevision() };
    }
    if (options.method === 'POST') throw new Error('No send fixture');
    return page(options.query ?? {});
  };
  const viewport = {
    scrollTop: 0, clientHeight: 350,
    get scrollHeight() { return chat.history.messages.reduce((height, row) => height + (row.image ? 260 : 100), 0); },
    getBoundingClientRect: () => ({ top: 100, bottom: 450, height: 350 }),
    scrollTo({ top }) { this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)); },
    card(id, image = false) {
      let offset = 0;
      const row = chat.history.messages.find((row) => row.id === id);
      if (!row) return null;
      for (const entry of chat.history.messages) { if (entry.id === id) break; offset += entry.image ? 260 : 100; }
      return { dataset: { messageId: String(id) }, focus: () => { state.focused = id; },
        getBoundingClientRect: () => {
          const top = 100 + offset - this.scrollTop + (image ? 35 : 0);
          const height = image ? 200 : row.image ? 260 : 100;
          return { top, bottom: top + height, width: 300, height };
        } };
    },
    querySelector(selector) { return this.card(Number(selector.match(/data-message-id="(\d+)"/)[1]), selector.includes('__thumb')); },
    querySelectorAll() { return chat.history.messages.map(row => this.card(row.id)); },
  };
  const route = { query, hash, path: '/order/test' };
  const context = vm.createContext({ exports: {}, require: name => ({
    '~/utils/chat-messages': messages, '~/utils/chat-photo': photo, '~/utils/chat-focus': focus,
  })[name], ref, reactive, toRefs, nextTick, Map, Set, File, FormData, AbortController, crypto,
  setTimeout, clearTimeout, URL, window: { innerHeight: 600, matchMedia: () => ({ matches: false }) },
  document: { visibilityState: 'visible', getElementById: () => ({ scrollIntoView() {} }), querySelector: () => null },
  defineProps: () => ({ base: '/orders/test', staff: false, unread: 0, readThrough, status: 'ASSEMBLING', issues: [] }),
  defineEmits: () => () => {}, useApiClient: () => api, useToast: () => ({ add() {} }), useRoute: () => route,
  useCommunicationRevision: () => ref(0), watch() {}, onMounted() {}, onBeforeUnmount: callback => callbacks.push(callback),
  useOrderPolling: callback => state.polls.push(callback), apiError: error => error.message,
  });
  vm.runInContext(compiled + '\nglobalThis.chat = { history, viewport, load, older, markVisible, focusChat, focusNew, imageReady, newUpdates, highlightedId, setViewing: value => { inView = value; } };', context);
  chat = context.chat;
  chat.viewport.value = viewport;
  chat.setViewing(true);
  t.after(() => callbacks.forEach(callback => callback()));
  return { chat, state, viewport, route };
}

test('exact old deep link loads its window, highlights and acknowledges only actually viewed messages', async t => {
  const { chat, state } = harness(t, Array.from({ length: 65 }, (_, i) => entry(i + 1)), { query: { chatMessage: '2' }, hash: '#order-chat', readThrough: 1 });
  await chat.load(); await chat.focusChat(); await nextTick();
  assert.equal(state.calls[0].options.query.around, 2);
  assert.equal(chat.history.messages[0].id, 2);
  assert.equal(chat.highlightedId.value, 2); assert.equal(state.focused, 2);
  assert.ok(state.readThrough >= 2 && state.readThrough < 10);
  assert.ok(!state.calls.some(call => call.options.body?.through === 65));
});

test('a new message at the bottom scrolls into view and clears after viewing', async t => {
  const { chat, state, viewport } = harness(t, Array.from({ length: 8 }, (_, i) => entry(i + 1)), { readThrough: 8 });
  await chat.load(); viewport.scrollTo({ top: viewport.scrollHeight });
  state.rows.push(entry(9)); await chat.load(); await chat.markVisible();
  assert.equal(viewport.scrollTop, viewport.scrollHeight - viewport.clientHeight);
  assert.equal(state.readThrough, 9); assert.equal(chat.newUpdates.size, 0);
});

test('viewed live updates clear even when an older unread message prevents advancing the cursor', async t => {
  const { chat, state, viewport } = harness(t, Array.from({ length: 65 }, (_, i) => entry(i + 1)), { readThrough: 1 });
  await chat.load(); viewport.scrollTo({ top: viewport.scrollHeight });
  state.rows.push(entry(66)); await chat.load(); await chat.markVisible();
  assert.equal(chat.newUpdates.size, 0);
  assert.equal(state.readThrough, 1);
  assert.ok(!state.calls.some(call => call.options.body?.through === 66));
});

test('history readers retain their scroll anchor and can focus the first of several incoming messages', async t => {
  const { chat, state, viewport } = harness(t, Array.from({ length: 15 }, (_, i) => entry(i + 1)), { readThrough: 15, hash: '#order-chat' });
  await chat.load(); viewport.scrollTop = 200;
  state.rows.push(entry(16), entry(17), entry(18)); await chat.load();
  assert.equal(viewport.scrollTop, 200); assert.equal(chat.newUpdates.size, 3);
  assert.equal(state.readThrough, 15);
  await chat.focusNew(); await chat.markVisible(); await nextTick();
  assert.equal(state.focused, 16); assert.equal(chat.highlightedId.value, 16);
  assert.equal(state.readThrough, 17); assert.equal(chat.newUpdates.size, 1);
  await chat.focusNew(); await chat.markVisible();
  assert.equal(state.focused, 18); assert.equal(state.readThrough, 18); assert.equal(chat.newUpdates.size, 0);
  assert.match(source, /Новые сообщения · \$\{newUpdates.size\}/);
});

test('photo revision preserves the card and history position, then reads only the loaded current thumbnail', async t => {
  const original = entry(2, { image: true });
  const { chat, state, viewport } = harness(t, [entry(1), original, ...Array.from({ length: 9 }, (_, i) => entry(i + 3))], { readThrough: 11, hash: '#order-chat' });
  await chat.load(); viewport.scrollTop = 500;
  const updated = { ...original, imageRevision: 2, revisionText: 'Этот товар', revisionActor: 'SELLER', revisionAt: '2026-10-05T11:00:00Z' };
  state.rows[1] = updated; state.revisions.push({ id: 7, messageId: 2, version: 2, message: updated });
  await chat.load(); assert.equal(viewport.scrollTop, 500); assert.equal(chat.newUpdates.size, 1);
  assert.equal(chat.history.messages.filter(row => row.id === 2).length, 1);
  assert.equal(chat.history.messages.find(row => row.id === 2).imageRevision, 2);
  await chat.focusNew(); assert.equal(state.revisionThrough, 0);
  chat.imageReady(2, 2); await nextTick(); await chat.markVisible();
  assert.equal(state.revisionThrough, 7); assert.equal(chat.newUpdates.size, 0); assert.equal(state.focused, 2);
});

test('customer Telegram login retains only supported exact-message links', () => {
  const path = '/order/11111111-1111-4111-8111-111111111111?chatMessage=21#order-chat';
  assert.equal(telegramReturnTo(path), path);
  for (const invalid of [path + '&token=secret', path.replace('21', '-1'), '/staff/orders/21#order-chat', '//example.com'])
    assert.equal(telegramReturnTo(invalid), '/catalog');
  assert.equal(focus.chatMessageId('21'), 21); assert.equal(focus.chatMessageId('2147483648'), undefined);
  assert.equal(focus.chatRectVisible({ top: 700, bottom: 900, height: 200 }, { top: 100, bottom: 1000 }, 600), false);
});

test('all strokes and dots use a scaled contrast outline on the same canvas that is exported', async () => {
  const strokes = [];
  const fills = [];
  const context = { beginPath() {}, moveTo() {}, lineTo() {}, arc() {},
    stroke() { strokes.push({ color: this.strokeStyle, width: this.lineWidth }); },
    fill() { fills.push(this.fillStyle); } };
  drawMarkup(context, { color: '#f43f5e', width: 3, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
  assert.deepEqual(strokes, [{ color: '#000000', width: 5 }, { color: '#f43f5e', width: 3 }]);
  drawMarkup(context, { color: '#111111', width: 6, points: [{ x: 5, y: 5 }] });
  assert.deepEqual(fills, ['#ffffff', '#111111']);
  assert.equal(markupOutline('#000000'), '#ffffff'); assert.equal(markupOutline('#facc15'), '#000000');
  const markup = await readFile(new URL('../app/components/order/Markup.vue', import.meta.url), 'utf8');
  assert.match(markup, /for \(const stroke of strokes.value\) drawMarkup\(context, stroke\)/);
  assert.match(markup, /const target = canvas.value;\s+redraw\(\);[\s\S]*target.toBlob/);
});

test('mobile wrappers remove stacked padding while desktop and accessible focus controls stay available', async () => {
  const coordination = await readFile(new URL('../app/components/order/Coordination.vue', import.meta.url), 'utf8');
  assert.match(coordination, /max-width: 39.999rem[\s\S]*padding-inline: 0; border-inline: 0/);
  assert.match(source, /\.chat :deep\(\.chat__body\) \{ padding: 0; \}/);
  assert.match(source, /\.chat__messages \{ padding: 0.25rem;/);
  assert.match(source, /env\(safe-area-inset-left\)/);
  assert.match(source, /min-width: 40rem[\s\S]*max-width: 82%/);
  assert.match(source, /tabindex="-1"/); assert.match(source, /:focus-visible/);
  assert.match(source, /@click="focusNew"/); assert.match(source, /aria-live="polite"/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});
