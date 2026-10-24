import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deliverScreen } from './delivery.js';
import { richEnabled } from './rich-policy.js';
import { bold, marked, customerScreen, fallbackHtml, productPhoto, richMessage, validScreen, screenNotice, type TelegramScreen } from './rich.js';
import { Logger } from '@nestjs/common';
import { localPhoto } from './photo.js';
vi.mock('./photo.js', () => ({ localPhoto: vi.fn(async () => undefined) }));
import { adjustData, productData, shoppingAction } from './shopping-callback.js';
import { serialUpdate } from './updates.js';
import { pageInfo } from './page.js';

const screen: TelegramScreen = { text: 'Укроп <рынок>\nЦена: 165 ₽\n\n& без <script>тегов</script>',
  keyboard: { inline_keyboard: [[{ text: '+1 · 165 ₽', callback_data: 'fixture', style: 'success' }]] } };
const fetcher = vi.fn<typeof fetch>();
let directory: string, config: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tg-rich-')); config = join(directory, 'policy.json');
  vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', config);
  vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', randomUUID()); vi.stubEnv('TELEGRAM_STAFF_BOT_TOKEN', randomUUID());
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', ''); vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
  vi.stubGlobal('fetch', fetcher); fetcher.mockReset().mockImplementation(async () => Response.json({ ok: true, result: { message_id: 92 } }));
  await writeFile(config, JSON.stringify({ enabled: true, customer: ['123'], staff: ['124'] }));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const body = (index = 0) => JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body));
const reject = (description = 'Bad Request: invalid rich message') => Response.json({ ok: false, error_code: 400, description }, { status: 400 });

it('renders native Rich blocks and buttons, with no HTML interpretation of user text', () => {
  const rich = richMessage(screen);
  expect(rich.blocks[0]).toEqual({ type: 'heading', size: 2, text: 'Укроп <рынок>' });
  expect(JSON.stringify(rich)).toContain('<script>'); // Literal structured text, never an html/markdown field.
  expect(rich).not.toHaveProperty('html'); expect(rich).not.toHaveProperty('markdown');
  expect(rich.blocks.at(-1)).toMatchObject({ type: 'buttons', buttons: [{ style: 'success' }] });
  expect(fallbackHtml(screen.text)).toContain('&lt;script&gt;');
  expect(fallbackHtml(screen.text)).not.toContain('<script>');
});
it('supports distinct allowlists, an immediate off switch and fails closed for missing/malformed config', async () => {
  expect(await richEnabled('customer', 123)).toBe(true); expect(await richEnabled('staff', 123)).toBe(false);
  await writeFile(config, '{"enabled":false}'); expect(await richEnabled('customer', 123)).toBe(false);
  await writeFile(config, 'invalid'); expect(await richEnabled('customer', 123)).toBe(false);
  await rm(config); expect(await richEnabled('customer', 123)).toBe(false);
});
it('sends and edits a Rich screen with the confirmed current message ID', async () => {
  expect(await deliverScreen('customer', { chatId: 123 }, screen)).toEqual({ status: 'sent', messageId: 92 });
  expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/sendRichMessage$/);
  expect(body()).toHaveProperty('rich_message.blocks'); expect(body()).not.toHaveProperty('text');
  await deliverScreen('customer', { chatId: 123, messageId: 92 }, screen);
  expect(String(fetcher.mock.calls[1]?.[0])).toMatch(/\/editMessageText$/); expect(body(1).message_id).toBe(92);
});
it('keeps one right-aligned basket row through customer processing and real send/edit payloads without per-button layout fields', async () => {
  const buttons = [{ text: 'Название товара', callback_data: 'open' }, { text: '−', callback_data: 'minus' },
    { text: '+', callback_data: 'plus' }, { text: '✕', callback_data: 'remove' }];
  const value = customerScreen({ ...screen, keyboard: { inline_keyboard: [buttons] }, rich: { blocks: [
    { type: 'buttons', align: 'right', buttons },
  ] } });
  await deliverScreen('customer', { chatId: 123 }, value);
  await deliverScreen('customer', { chatId: 123, messageId: 92 }, value);
  for (const index of [0, 1]) {
    expect(body(index).rich_message.blocks).toEqual([{ type: 'buttons', align: 'right', buttons }]);
    expect(body(index)).not.toHaveProperty('buttonsAlign');
  }
});
it('uses escaped HTML and inline buttons for a chat outside the Rich allowlist', async () => {
  await deliverScreen('customer', { chatId: 125 }, screen);
  expect(body()).toMatchObject({ parse_mode: 'HTML', reply_markup: screen.keyboard });
  expect(body().text).toContain('&lt;рынок&gt;'); expect(body()).not.toHaveProperty('rich_message');
});
describe.each(['customer', 'staff'] as const)('%s global delivery', bot => {
  beforeEach(async () => { await writeFile(config, JSON.stringify({ enabled: true, global: { customer: true, staff: true } })); });
  it('sends and edits outside the old allowlist, then switches the same message to HTML immediately', async () => {
    await deliverScreen(bot, { chatId: 987654321 }, screen);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/sendRichMessage$/);
    await deliverScreen(bot, { chatId: 987654321, messageId: 92 }, screen);
    expect(body(1)).toHaveProperty('rich_message'); expect(body(1).message_id).toBe(92);
    await writeFile(config + '.next', '{"enabled":false}'); await rename(config + '.next', config);
    await deliverScreen(bot, { chatId: 987654321, messageId: 92 }, screen);
    expect(body(2)).toMatchObject({ message_id: 92, parse_mode: 'HTML', reply_markup: screen.keyboard });
    expect(body(2)).not.toHaveProperty('rich_message'); expect(body(2).text).toContain('&lt;рынок&gt;');
  });
  it('keeps callbacks and edit target through confirmed Rich rejection and HTML fallback', async () => {
    fetcher.mockResolvedValueOnce(reject());
    expect(await deliverScreen(bot, { chatId: 987654321, messageId: 91 }, screen)).toEqual({ status: 'sent', messageId: 92 });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(body(1)).toMatchObject({ message_id: 91, parse_mode: 'HTML', reply_markup: screen.keyboard });
  });
  it.each(['timeout', '500', '429', '403'])('does not retry or fall back after %s outside the old allowlist', async failure => {
    if (failure === 'timeout') fetcher.mockRejectedValueOnce(new Error('Lost response'));
    else fetcher.mockResolvedValueOnce(new Response('{}', { status: Number(failure) }));
    expect((await deliverScreen(bot, { chatId: 987654321 }, screen)).status).not.toBe('sent');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uploads the existing product photo as JPEG outside the old allowlist', async () => {
    vi.mocked(localPhoto).mockResolvedValueOnce(new Uint8Array([255,216,255,217]));
    await deliverScreen(bot, { chatId: 987654321 }, { ...screen, rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'https://shop.example/uploads/products/' + randomUUID() + '.webp' } }] } });
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect(form).toBeInstanceOf(FormData); expect(form.get('rich_message')).toContain('attach://photo');
    expect((form.get('photo') as File).type).toBe('image/jpeg');
  });
});
it('falls back only after a confirmed Rich rejection, preserving the same edit target', async () => {
  fetcher.mockResolvedValueOnce(reject());
  expect(await deliverScreen('customer', { chatId: 123, messageId: 91 }, screen)).toEqual({ status: 'sent', messageId: 92 });
  expect(fetcher).toHaveBeenCalledTimes(2); expect(body(1)).toMatchObject({ message_id: 91, parse_mode: 'HTML' });
});
it.each([500, 502, 504, 429, 403])('never falls back or resends after HTTP %s', async status => {
  fetcher.mockResolvedValueOnce(new Response('{}', { status }));
  const result = await deliverScreen('customer', { chatId: 123 }, screen);
  expect(result.status).not.toBe('sent'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['transport', 'malformed', 'missing-id'])('retains UNKNOWN for %s instead of sending again', async failure => {
  if (failure === 'transport') fetcher.mockRejectedValueOnce(new Error('timeout'));
  if (failure === 'malformed') fetcher.mockResolvedValueOnce(new Response('not-json'));
  if (failure === 'missing-id') fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: {} }));
  expect(await deliverScreen('customer', { chatId: 123 }, screen)).toEqual({ status: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('handles unchanged edits as success without creating a new card', async () => {
  fetcher.mockResolvedValueOnce(reject('Bad Request: message is not modified'));
  expect(await deliverScreen('customer', { chatId: 123, messageId: 91 }, screen)).toEqual({ status: 'unchanged' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('replaces a definitely uneditable card and returns its new ID', async () => {
  fetcher.mockResolvedValueOnce(reject('Bad Request: message to edit not found'));
  expect(await deliverScreen('customer', { chatId: 123, messageId: 91 }, screen)).toEqual({ status: 'sent', messageId: 92 });
  expect(body(1)).not.toHaveProperty('message_id'); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('retries a definitely rejected photo as a Rich card without photo, once', async () => {
  fetcher.mockResolvedValueOnce(reject('Bad Request: failed to get HTTP URL content'));
  const withPhoto: TelegramScreen = { ...screen, rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'https://shop.example/uploads/products/fixture.webp' } }, { type: 'paragraph', text: 'Укроп' }] } };
  await deliverScreen('customer', { chatId: 123 }, withPhoto);
  expect(body(0).rich_message.blocks.some((block: { type: string }) => block.type === 'photo')).toBe(true);
  expect(body(1).rich_message.blocks.some((block: { type: string }) => block.type === 'photo')).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('accepts shop product media only, with no credentials, query parameters or external URLs', () => {
  vi.stubEnv('ORDER_SITE_URL', 'https://shop.example');
  expect(productPhoto('/uploads/products/fixture.webp')).toMatchObject({ photo: { media: 'https://shop.example/uploads/products/fixture.webp' } });
  for (const url of ['https://evil.example/image.jpg', '/api/auth/me', '/uploads/products/x?token=secret', 'javascript:alert(1)']) expect(productPhoto(url)).toBeUndefined();
});
it('validates callback bytes, keyboard width and payload size', () => {
  expect(validScreen(screen)).toBe(true);
  expect(validScreen({ ...screen, keyboard: { inline_keyboard: [[{ text: 'bad', callback_data: 'я'.repeat(33) }]] } })).toBe(false);
  expect(validScreen({ ...screen, keyboard: { inline_keyboard: [Array(9).fill(screen.keyboard.inline_keyboard[0]![0]!)] } })).toBe(false);
});
it('round-trips the largest immediate quantity callbacks with page and origin inside 64 bytes', () => {
  for (const origin of ['category','basket','quick'] as const) for (const delta of [-1000000,1000000]) {
    const data = adjustData('11111111-1111-4111-8111-111111111111', 2147483647, delta, 'PIECE', { page: 10000, origin });
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(shoppingAction(data)).toMatchObject({ kind: 'adjust', delta, quantityUnit: 'PIECE', page: 10000, origin });
    expect(shoppingAction(productData(2147483647, { page: 10000, origin }))).toMatchObject({ kind: 'open', page: 10000, origin });
  }
});
it('clamps empty and removed pages rather than showing an out-of-range page', () => {
  expect(pageInfo(37, 1, 8)).toMatchObject({ page: 1, pages: 5, first: 9, last: 16 });
  expect(pageInfo(3, 9999, 8)).toMatchObject({ page: 0, pages: 1 });
  expect(pageInfo(0, 9999, 8)).toMatchObject({ page: 0, first: 0, last: 0 });
});
it('serializes presentation per bot/chat and deduplicates a repeated Telegram update', async () => {
  const chat = 700000 + Math.floor(Math.random() * 100000), gate = Promise.withResolvers<void>(), order: number[] = [];
  const first = serialUpdate('customer', chat, 1, async () => { order.push(1); await gate.promise; order.push(2); });
  const duplicate = serialUpdate('customer', chat, 1, async () => { order.push(99); });
  const second = serialUpdate('customer', chat, 2, async () => { order.push(3); });
  await Promise.resolve(); expect(order).not.toContain(3); gate.resolve(); await Promise.all([first, duplicate, second]);
  expect(order).toEqual([1, 2, 3]);
});

it('reuses only confirmed Telegram photo file_ids on subsequent edits and keeps photo after +/-', async () => {
  const path = 'https://shop.example/uploads/products/' + randomUUID() + '.webp';
  const photoScreen: TelegramScreen = { ...screen, rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: path } }] } };
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 92, rich_message: { blocks: [{ type: 'photo', photo: [{ file_id: 'small', width: 10 }, { file_id: 'confirmed-file', width: 1000 }] }] } } }));
  await deliverScreen('customer', { chatId: 123 }, photoScreen);
  await deliverScreen('customer', { chatId: 123, messageId: 92 }, photoScreen);
  expect(body(0).rich_message.blocks[0].photo.media).toBe(path);
  expect(body(1).rich_message.blocks[0].photo.media).toBe('confirmed-file');
});
it('does not retry media or fallback after a lost response with a photo', async () => {
  const photoScreen: TelegramScreen = { ...screen, rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'https://shop.example/uploads/' + randomUUID() } }] } };
  fetcher.mockRejectedValueOnce(new Error('timeout'));
  expect(await deliverScreen('customer', { chatId: 123 }, photoScreen)).toEqual({ status: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('recovers a definitely rejected cached file_id through the original public URL, without retrying an unknown result', async () => {
  const path = 'https://shop.example/uploads/' + randomUUID();
  const photoScreen: TelegramScreen = { ...screen, rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: path } }] } };
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 92, rich_message: { blocks: [{ type: 'photo', photo: [{ file_id: 'cached-test' }] }] } } }));
  await deliverScreen('customer', { chatId: 123 }, photoScreen);
  fetcher.mockResolvedValueOnce(reject('Bad Request: wrong file identifier')).mockRejectedValueOnce(new Error('lost reply'));
  expect(await deliverScreen('customer', { chatId: 123, messageId: 92 }, photoScreen)).toEqual({ status: 'unknown' });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(body(1).rich_message.blocks[0].photo.media).toBe('cached-test');
  expect(body(2).rich_message.blocks[0].photo.media).toBe(path);
});
it('emits only fixed diagnostic codes when media is rejected and text fallback is used', async () => {
  const log = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  try {
    fetcher.mockResolvedValueOnce(reject()).mockResolvedValueOnce(reject());
    await deliverScreen('customer', { chatId: 123 }, { ...screen, mediaReason: 'invalid_url', rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'https://shop.example/uploads/' + randomUUID() } }] } });
    expect(log.mock.calls.flat()).toEqual(expect.arrayContaining(['invalid_url', 'media_rejected', 'fallback_used']));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/https|123|secret/);
    expect(body(2)).toHaveProperty('parse_mode', 'HTML');
  } finally { log.mockRestore(); }
});
it('preserves semantic bold fallback, marked literals and notices without HTML injection', () => {
  const value: TelegramScreen = { ...screen, text: 'ИТОГО <x>\nДоставка', fallback: [bold('ИТОГО <x>'), marked('Доставка')], rich: { blocks: [{ type: 'paragraph', text: marked('<script>') }] } };
  const updated = screenNotice(value, '✅ Изменено <b>');
  const fallback = fallbackHtml(updated.text, updated.fallback);
  expect(fallback).toContain('<b>ИТОГО &lt;x&gt;</b>');
  expect(fallback).toContain('✅ Изменено &lt;b&gt;');
  expect(fallback).not.toContain('<script>');
  expect(JSON.stringify(richMessage(updated))).toContain('✅ Изменено <b>');
});
it('uploads one local JPEG in multipart, and never retries after an unknown upload result', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const prepared = vi.mocked(localPhoto);
  prepared.mockResolvedValueOnce(new Uint8Array([255, 216, 255, 217]));
  fetcher.mockRejectedValueOnce(new Error('Lost upload response'));
  const result = await deliverScreen('customer', { chatId: 123 }, { ...screen, rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'https://shop.example/uploads/products/upload.webp' } }] } });
  expect(result).toEqual({ status: 'unknown' }); expect(fetcher).toHaveBeenCalledTimes(1);
  const form = fetcher.mock.calls[0]![1]!.body;
  expect(form).toBeInstanceOf(FormData);
  expect((form as FormData).get('rich_message')).toContain('attach://photo');
  const photo = (form as FormData).get('photo');
  expect(photo).toBeInstanceOf(File);
  expect((photo as File).type).toBe('image/jpeg');
  expect(timeout).toHaveBeenCalledWith(30000);
  timeout.mockRestore();
});

const galleryScreen = (count = 8): TelegramScreen => ({ ...screen, rich: { blocks: [
  { type: 'heading', size: 2, text: 'Фрукты' },
  ...Array.from({ length: Math.ceil(count / 2) }, (_, row) => ({ type: 'collage' as const,
    blocks: Array.from({ length: Math.min(2, count - row * 2) }, (_, col) => ({ type: 'photo' as const,
      photo: { type: 'photo' as const, media: 'https://shop.example/uploads/products/gallery-' + (row * 2 + col) + '.webp' } })) })),
] } });
it.each(['send-edit', 'rejected', 'unknown'] as const)('keeps table callbacks and the complete HTML keyboard through %s', async mode => {
  const open = { text: 'Полное название', callback_data: 'open-real-id', style: 'link' as const };
  const add = { text: 'Добавить в ', callback_data: 'add-revision-real-id', style: 'success' as const };
  const fallback = [{ ...open, text: 'Полное название · 110 ₽', style: 'primary' as const }, add];
  const value: TelegramScreen = { ...screen, keyboard: { inline_keyboard: [fallback] }, rich: { blocks: [{ type: 'table', is_compact: true,
    cells: [[{ text: [{ type: 'button', button: open }, '\n', { type: 'bold', text: '110 ₽' }], align: 'left', valign: 'top' }],
      [{ text: { type: 'button', button: add }, align: 'left', valign: 'top' }]] }] } };
  expect(richMessage(value).blocks.map(block => block.type)).toEqual(['table']);
  if (mode === 'rejected') fetcher.mockResolvedValueOnce(reject());
  if (mode === 'unknown') fetcher.mockRejectedValueOnce(new Error('Lost table response'));
  const result = await deliverScreen('customer', { chatId: 123 }, value);
  if (mode === 'unknown') { expect(result.status).toBe('unknown'); expect(fetcher).toHaveBeenCalledTimes(1); }
  else if (mode === 'rejected') {
    expect(result.status).toBe('sent'); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body(1)).toMatchObject({ parse_mode: 'HTML', reply_markup: value.keyboard });
  } else {
    expect(result.status).toBe('sent');
    await deliverScreen('customer', { chatId: 123, messageId: 92 }, value);
    expect(fetcher.mock.calls[1]![0]).toContain('editMessageText');
    expect(body(1).rich_message).toEqual(body(0).rich_message);
    expect(body(0).rich_message.blocks[0].cells[1][0].text.button).toEqual(add);
  }
});
it('prepares standalone category photos at 4:3, keeps thumbnail file_ids separate and never sends internal layout flags', async () => {
  const path = 'https://shop.example/uploads/products/' + randomUUID() + '.webp';
  const photo = { type: 'photo' as const, photo: { type: 'photo' as const, media: path } };
  const value: TelegramScreen = { ...screen, thumbnailPhotos: true, rich: { blocks: [photo] } };
  vi.mocked(localPhoto).mockResolvedValueOnce(new Uint8Array([255,216,255,217]));
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 92, rich_message: { blocks: [
    { type: 'photo', photo: [{ file_id: 'category-landscape' }] },
  ] } } }));
  await deliverScreen('customer', { chatId: 123 }, value);
  expect(localPhoto).toHaveBeenCalledWith(path, undefined, true);
  const form = fetcher.mock.calls[0]![1]!.body as FormData;
  expect(form.get('rich_message')).not.toContain('thumbnailPhotos');
  await deliverScreen('customer', { chatId: 123, messageId: 92 }, value);
  expect(body(1).rich_message.blocks[0].photo.media).toBe('category-landscape');
  await deliverScreen('customer', { chatId: 123 }, { ...screen, rich: { blocks: [photo] } });
  expect(body(2).rich_message.blocks[0].photo.media).toBe(path);
});
it.each(['send-edit', 'missing', 'rejected', 'html', 'unknown'] as const)('preserves native photo caption buttons and fallback bindings through %s', async mode => {
  const path = 'https://shop.example/uploads/products/' + randomUUID() + '.webp';
  const buttons = [{ text: 'Товар · 110 ₽', callback_data: 'open-actual-id', style: 'primary' as const },
    { text: 'Добавить в 🛒', callback_data: 'add-actual-id', style: 'success' as const }];
  const caption = { text: [{ type: 'button' as const, button: buttons[0]! }, ' ', { type: 'button' as const, button: buttons[1]! }] };
  const value: TelegramScreen = { ...screen, keyboard: { inline_keyboard: [buttons] }, rich: { blocks: [{ type: 'collage', blocks: [
    { type: 'photo', photo: { type: 'photo', media: path }, caption },
    { type: 'photo', photo: { type: 'photo', media: path + '-2' }, caption },
  ] }] } };
  expect(richMessage(value).blocks).toHaveLength(2);
  // Client-hidden captions must never suppress the real, interactive keyboard projection.
  expect(richMessage(value).blocks.at(-1)).toEqual({ type: 'buttons', buttons });
  expect(fallbackHtml('test', [caption.text])).toBe('Товар · 110 ₽ Добавить в 🛒');
  vi.mocked(localPhoto).mockImplementation(async media => mode === 'missing' || !media.startsWith('https:') ? undefined : new Uint8Array([255,216,255,217]));
  if (mode === 'rejected' || mode === 'html') fetcher.mockResolvedValueOnce(reject());
  if (mode === 'html') fetcher.mockResolvedValueOnce(reject());
  if (mode === 'unknown') fetcher.mockRejectedValueOnce(new Error('lost caption reply'));
  if (mode === 'send-edit') fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 92, rich_message: { blocks: [{ type: 'collage', blocks: [
    { type: 'photo', photo: [{ file_id: 'caption-1' }], caption }, { type: 'photo', photo: [{ file_id: 'caption-2' }], caption },
  ] }] } } }));
  const result = await deliverScreen('customer', { chatId: 123 }, value);
  if (mode === 'unknown') { expect(result.status).toBe('unknown'); expect(fetcher).toHaveBeenCalledTimes(1); }
  else if (mode === 'send-edit') {
    await deliverScreen('customer', { chatId: 123, messageId: 92 }, value);
    expect(body(1).rich_message.blocks[0].blocks[0]).toMatchObject({ photo: { media: 'caption-1' }, caption });
    expect(body(1).rich_message.blocks[0].blocks[1]).toMatchObject({ photo: { media: 'caption-2' }, caption });
    expect(body(1).rich_message.blocks.at(-1)).toEqual({ type: 'buttons', buttons });
  } else {
    const payload = body(mode === 'html' ? 2 : mode === 'rejected' ? 1 : 0);
    if (mode === 'html') expect(payload.reply_markup.inline_keyboard).toEqual([buttons]);
    else expect(payload.rich_message.blocks).toEqual([{ type: 'paragraph', text: caption.text }, { type: 'paragraph', text: caption.text }, { type: 'buttons', buttons }]);
  }
  vi.mocked(localPhoto).mockImplementation(async () => undefined);
});
it('uploads all 8 nested gallery photos once, caches returned IDs per bot and preserves their tree order', async () => {
  vi.mocked(localPhoto).mockImplementation(async url => url.startsWith('https:') ? new Uint8Array([255, 216, 255, 217]) : undefined);
  const received = Array.from({ length: 4 }, (_, row) => ({ type: 'collage', blocks: Array.from({ length: 2 }, (_, col) => ({ type: 'photo', photo: [{ file_id: 'gallery-' + (row * 2 + col) }] })) }));
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 92, rich_message: { blocks: received } } }));
  const value = galleryScreen();
  await deliverScreen('customer', { chatId: 123 }, value);
  const form = fetcher.mock.calls[0]![1]!.body as FormData;
  expect(form).toBeInstanceOf(FormData);
  expect([...form.values()].filter(value => value instanceof File)).toHaveLength(8);
  const sent = JSON.parse(String(form.get('rich_message')));
  expect(sent.blocks[1].blocks[0].photo.media).toBe('attach://photo');
  expect(sent.blocks[4].blocks[1].photo.media).toBe('attach://photo7');
  await deliverScreen('customer', { chatId: 123, messageId: 92 }, value);
  expect(body(1).rich_message.blocks[1].blocks[0].photo.media).toBe('gallery-0');
  expect(body(1).rich_message.blocks[4].blocks[1].photo.media).toBe('gallery-7');
  await deliverScreen('staff', { chatId: 124 }, value);
  expect(fetcher.mock.calls[2]![1]!.body).toBeInstanceOf(FormData);
  // A thumbnail cache entry must never downgrade the first full product photograph.
  await deliverScreen('customer', { chatId: 123 }, { ...screen, rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'https://shop.example/uploads/products/gallery-0.webp' } }] } });
  expect(fetcher.mock.calls[3]![1]!.body).toBeInstanceOf(FormData);
  vi.mocked(localPhoto).mockImplementation(async () => undefined);
});
it.each([false, true].flatMap(standalone => (['missing', 'rejected', 'unknown'] as const).map(failure => ({ standalone, failure }))))('degrades a $failure gallery (standalone=$standalone) safely and retains all selection callbacks', async ({ standalone, failure }) => {
  const value = galleryScreen(2);
  if (standalone) {
    value.thumbnailPhotos = true;
    value.rich!.blocks = value.rich!.blocks.flatMap(block => block.type === 'collage' ? block.blocks : [block]);
  }
  vi.mocked(localPhoto).mockImplementation(async url => failure === 'missing' && url.endsWith('gallery-1.webp') ? undefined : new Uint8Array([255,216,255,217]));
  if (failure === 'rejected') fetcher.mockResolvedValueOnce(reject());
  if (failure === 'unknown') fetcher.mockRejectedValueOnce(new Error('lost gallery reply'));
  const result = await deliverScreen('customer', { chatId: 123, messageId: 92 }, value);
  expect(fetcher).toHaveBeenCalledTimes(failure === 'rejected' ? 2 : 1);
  if (failure === 'unknown') expect(result).toEqual({ status: 'unknown' });
  else {
    const payload = body(failure === 'rejected' ? 1 : 0);
    expect(JSON.stringify(payload)).not.toContain('collage');
    expect(payload.rich_message.blocks.at(-1).buttons).toEqual(screen.keyboard.inline_keyboard[0]);
    expect(payload.message_id).toBe(92);
  }
  vi.mocked(localPhoto).mockImplementation(async () => undefined);
});
