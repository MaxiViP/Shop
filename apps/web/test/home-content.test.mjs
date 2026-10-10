import test from 'node:test';
import assert from 'node:assert/strict';
import { heroDuration, visibleHomeSlides } from '../app/utils/home-slides.ts';
import { moscowInput, pickupDate } from '../app/utils/pickup.ts';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, ref } from 'vue';
import * as vue from 'vue';
import { parse, compileTemplate } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';

test('the real carousel timer respects reading time and is bounded, independently of browser acceleration', () => {
  assert.equal(heroDuration(undefined), 8000);
  assert.equal(heroDuration({ title: 'Рынок', text: 'Выбирайте продукты' }), 8000);
  assert.equal(heroDuration({ title: 'Рынок', text: Array(29).fill('слово').join(' ') }), 9000);
  assert.equal(heroDuration({ title: 'Рынок', text: Array(100).fill('слово').join(' ') }), 25000);
  assert.equal(heroDuration({ title: 'Рынок', text: '' }, true), 15000);
});

test('SSR and hydration use the same order; expired offers are omitted even when refreshing fails', () => {
  const end = '2026-10-10T09:00:00.000Z';
  const data = { serverNow: '2026-10-10T08:59:00.000Z', validUntil: end, slides: [
    { id: 2, content: 'CUSTOM', endsAt: null }, { id: 1, content: 'CUSTOM', endsAt: end },
    { id: 3, content: 'FREE_DELIVERY', endsAt: null }, { id: 4, content: 'SEASONAL', endsAt: null },
    { id: 5, content: 'HITS', endsAt: null },
  ] };
  assert.equal(visibleHomeSlides(data, null), data.slides);
  assert.deepEqual(visibleHomeSlides(data, Date.parse(end) - 1).map(slide => slide.id), [2, 1, 3, 4, 5]);
  assert.deepEqual(visibleHomeSlides(data, Date.parse(end)).map(slide => slide.id), [2]);
  assert.deepEqual(visibleHomeSlides({ ...data, slides: [] }, null), []);
  assert.deepEqual(visibleHomeSlides({ ...data, slides: [data.slides[0]] }, null).map(slide => slide.id), [2]);
});

test('the carousel renders and switches each slide title, description, image and CTA together', async () => {
  const source = await readFile(new URL('../app/components/home/HeroCarousel.vue', import.meta.url), 'utf8');
  const descriptor = parse(source).descriptor;
  let script = descriptor.scriptSetup.content;
  const ast = ts.createSourceFile('HeroCarousel.ts', script, ts.ScriptTarget.Latest, true);
  for (const statement of [...ast.statements].reverse()) if (ts.isImportDeclaration(statement))
    script = script.slice(0, statement.getStart()) + script.slice(statement.end);
  const code = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const slides = ref([
    { id: 1, title: 'Рынок рядом', text: 'Продукты с прилавка.', image: '/images/hero/hero-0.webp',
      position: 'center', eyebrow: 'Москва', buttonLabel: 'В каталог', to: '/catalog' },
    { id: 2, title: 'Доставка по Москве', text: 'Условия доставки после сборки.', image: '/images/hero/hero-2.webp',
      position: 'center', eyebrow: 'Доставка', buttonLabel: 'Условия доставки', to: '/delivery' },
  ]);
  const context = { ref, computed, watch: () => {}, onMounted: () => {}, onBeforeUnmount: () => {},
    useHomeSlides: async () => ({ slides }), useAsset: () => value => value, heroDuration,
    setTimeout: () => 1, clearTimeout: () => {} };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const scope = await new AsyncFunction(...Object.keys(context), code + `
    return { activeSlide, featureSlide, compact, heroSlides, activeIndex, slideCount, paused, hovered, focused,
      asset, changeSlide, startSwipe, endSwipe, cancelSwipe, leaveFocus };`)(...Object.values(context));
  const template = compileTemplate({ source: descriptor.template.content, filename: 'HeroCarousel.vue', id: 'hero-test' });
  assert.deepEqual(template.errors, []);
  const compiled = ts.transpileModule(template.code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', compiled)(() => vue, exports);
  async function render() {
    const app = vue.createSSRApp({ render: exports.render, setup: () => scope });
    app.component('UButton', { props: ['to'], setup: (props, { slots }) => () => vue.h(props.to ? 'a' : 'button',
      props.to ? { href: props.to } : {}, slots.default?.()) });
    app.component('UIcon', { render: () => vue.h('span') });
    return renderToString(app);
  }
  const first = await render();
  assert.match(first, /<h1[^>]*>\s*Рынок рядом\s*<\/h1>/);
  assert.match(first, /src="\/images\/hero\/hero-0\.webp"/);
  assert.match(first, /href="\/catalog"[^>]*>\s*В каталог/);
  scope.changeSlide(1);
  const second = await render();
  assert.match(second, /<h1[^>]*>\s*Доставка по Москве\s*<\/h1>/);
  assert.match(second, /src="\/images\/hero\/hero-2\.webp"/);
  assert.match(second, /href="\/delivery"[^>]*>\s*Условия доставки/);
  assert.doesNotMatch(second, /href="\/catalog"/);
  slides.value[1] = { ...slides.value[1], title: 'Изменено в админке', text: 'Новое описание', to: '/cart' };
  const edited = await render();
  assert.match(edited, /<h1[^>]*>\s*Изменено в админке\s*<\/h1>/);
  assert.match(edited, /href="\/cart"/);
  assert.equal(slides.value[0].title, 'Рынок рядом');

  // Exercise the actual template while leave animations finish at different times.
  const leaves = [];
  const animated = { ...vue, Transition: {
    props: ['mode'],
    setup: (props, { attrs, slots }) => () => vue.h(vue.BaseTransition, {
      ...attrs, mode: props.mode, onLeave: (_element, done) => leaves.push(done),
    }, slots),
  } };
  const animationExports = {};
  new Function('require', 'exports', compiled)(() => animated, animationExports);
  const node = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null });
  function remove(element) {
    if (element.parent) element.parent.children.splice(element.parent.children.indexOf(element), 1);
    element.parent = null;
  }
  function insert(element, parent, anchor = null) {
    remove(element);
    const index = anchor ? parent.children.indexOf(anchor) : parent.children.length;
    parent.children.splice(index, 0, element); element.parent = parent;
  }
  const renderer = vue.createRenderer({
    createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
    insert, remove, parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    setText: (element, text) => { element.text = text; },
    setElementText: (element, text) => { element.text = text; element.children = []; },
    patchProp: (element, key, _previous, value) => { element.props[key] = value; },
    insertStaticContent: (text, parent, anchor) => {
      const element = node('#static', text); insert(element, parent, anchor); return [element, element];
    },
  });
  const root = node('root');
  scope.activeIndex.value = 0;
  const app = renderer.createApp({ render: animationExports.render, setup: () => scope });
  app.component('UButton', { props: ['to'], setup: (props, { slots }) => () => vue.h(props.to ? 'a' : 'button',
    props.to ? { href: props.to } : {}, slots.default?.()) });
  app.component('UIcon', { render: () => vue.h('span') });
  app.mount(root);
  const descendants = element => [element, ...element.children.flatMap(descendants)];
  function assertSynchronized() {
    const nodes = descendants(root);
    const content = nodes.find(element => element.props.class?.includes('hero__content--active'));
    const image = nodes.find(element => element.props.class === 'hero__image');
    if (!content) { assert.equal(image, undefined); return; }
    const current = slides.value.find(slide => slide.id === content.props['data-slide-id']);
    const children = descendants(content);
    const text = element => element?.text + (element?.children.map(text).join('') ?? '');
    assert.equal(text(children.find(element => element.tag === 'h1')).trim(), current.title);
    assert.equal(text(children.find(element => element.props.class === 'hero__text')).trim(), current.text);
    assert.equal(image?.props.src, current.image ?? undefined, 'image and content must belong to the same slide during transitions');
    assert.equal(children.find(element => element.tag === 'a')?.props.href, current.to ?? undefined);
  }
  async function finishAnimations() {
    assertSynchronized();
    while (leaves.length) { leaves.shift()(); await vue.nextTick(); assertSynchronized(); }
  }
  scope.changeSlide(1); await vue.nextTick(); await finishAnimations();
  slides.value.push({ id: 3, title: 'Объявление', text: 'Без изображения и кнопки.', image: null, buttonLabel: null, to: null });
  scope.changeSlide(1); await vue.nextTick(); await finishAnimations();
  scope.changeSlide(1); await vue.nextTick();
  scope.changeSlide(1); await vue.nextTick(); await finishAnimations();
  assert.equal(descendants(root).find(element => element.props.class?.includes('hero__content--active')).props['data-slide-id'], 2);
  app.unmount();

  slides.value = [];
  assert.doesNotMatch(await render(), /class="hero/);
});

test('Moscow inputs round-trip across UTC midnight and do not depend on browser timezone', () => {
  for (const value of ['2026-10-10T00:30', '2026-10-10T23:59', '2026-12-31T01:00']) {
    const utc = pickupDate(value).toISOString();
    assert.equal(moscowInput(utc), value);
    assert.equal(utc.slice(11, 16), value.endsWith('00:30') ? '21:30' : value.endsWith('23:59') ? '20:59' : '22:00');
  }
  assert.equal(moscowInput(null), '');
  assert.equal(pickupDate('2026-02-30T10:00'), null);
});

test('the async slide composable registers lifecycle before SSR resolves, expires stale offers and cleans up its timers', async () => {
  let source = await readFile(new URL('../app/composables/useHomeSlides.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('useHomeSlides.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement))
    source = source.slice(0, statement.getStart()) + source.slice(statement.end);
  const code = ts.transpileModule(source.replace(/^export /gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  let now = Date.parse('2026-10-10T09:00:00.000Z'), active = true, resolve, sequence = 0;
  const data = ref({ serverNow: new Date(now).toISOString(), validUntil: new Date(now + 2000).toISOString(),
    slides: [{ id: 1, content: 'CUSTOM', endsAt: new Date(now + 2000).toISOString() }, { id: 2, content: 'FREE_DELIVERY', endsAt: null }] });
  const response = Object.assign(new Promise(done => { resolve = done; }), { data, refresh: async () => {} });
  const mounted = [], unmounted = [], timers = new Map(), intervals = new Map(), listeners = new Map();
  const target = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const context = { ref, computed, visibleHomeSlides, Date: { now: () => now, parse: Date.parse },
    useApi: () => response, window: target, document: target,
    setTimeout: (fn, delay) => { timers.set(++sequence, { fn, delay }); return sequence; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { intervals.set(++sequence, { fn, delay }); return sequence; }, clearInterval: id => intervals.delete(id),
    onMounted: fn => { assert.ok(active, 'onMounted called after the Vue instance was lost'); mounted.push(fn); },
    onBeforeUnmount: fn => { assert.ok(active, 'onBeforeUnmount called after the Vue instance was lost'); unmounted.push(fn); },
  };
  const create = new Function(...Object.keys(context), code + '\nreturn useHomeSlides;')(...Object.values(context));
  const pending = create(); active = false;
  assert.equal(mounted.length, 1); assert.equal(unmounted.length, 1);
  resolve(); const state = await pending;
  assert.deepEqual(state.slides.value.map(slide => slide.id), [1, 2]);
  mounted[0]();
  assert.equal(timers.size, 1); assert.equal(intervals.size, 1);
  now += 2000; intervals.values().next().value.fn();
  assert.deepEqual(state.slides.value, []);
  unmounted[0]();
  assert.equal(timers.size, 0); assert.equal(intervals.size, 0); assert.equal(listeners.size, 0);
});
