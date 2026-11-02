import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deliverScreen } from './delivery.js';
import { richMessage, type TelegramScreen } from './rich.js';
import { catalogImage } from './catalog-photo.js';
vi.mock('./catalog-photo.js', () => ({ isCatalogPhoto: (value: string) => value.startsWith('telegram:catalog-pair:v1:'), catalogImage: vi.fn() }));
vi.mock('./photo.js', () => ({ localPhoto: vi.fn(async () => undefined) }));
let directory: string;
const fetcher = vi.fn<typeof fetch>();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'catalog-delivery-'));
  await writeFile(join(directory, 'policy.json'), '{"enabled":true,"global":{"customer":true}}');
  vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', join(directory, 'policy.json')); vi.stubEnv('TELEGRAM_CUSTOMER_BOT_TOKEN', randomUUID());
  vi.stubEnv('TELEGRAM_CUSTOMER_GATEWAY_URL', ''); vi.stubEnv('TELEGRAM_STAFF_GATEWAY_URL', '');
  fetcher.mockReset().mockResolvedValue(Response.json({ ok: true, result: { message_id: 71 } })); vi.stubGlobal('fetch', fetcher);
  vi.mocked(catalogImage).mockReset().mockResolvedValue({ bytes: new Uint8Array([255,216,255,217]), width: 960, height: 556, panels: [] });
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
function screen(): TelegramScreen {
  const open = [1, 2].map(id => ({ text: 'Открыть товар', style: 'primary' as const, callback_data: 'open-' + id }));
  const add = [1, 2].map(id => ({ text: 'Добавить в ', style: 'success' as const, callback_data: 'revision-add-' + id }));
  const rows = [{ type: 'buttons' as const, buttons: open, align: 'center' as const }, { type: 'buttons' as const, buttons: add, align: 'center' as const }];
  return { text: 'Фрукты · 1–2/2\nКиви — 110 ₽\nСлива — 220 ₽',
    keyboard: { inline_keyboard: [[{ ...open[0]!, text: 'Киви · 110 ₽' }, add[0]!], [{ ...open[1]!, text: 'Слива · 220 ₽' }, add[1]!]] },
    richKeyboard: { inline_keyboard: [] }, rich: { blocks: [{ type: 'paragraph', text: 'Фрукты · 1–2/2' },
      { type: 'photo', photo: { type: 'photo', media: 'telegram:catalog-pair:v1:' + 'a'.repeat(64) } }, ...rows] },
    mediaFallback: [{ type: 'paragraph', text: 'Киви · 110 ₽\nСлива · 220 ₽' }, ...rows] };
}
const payload = (index = 0) => {
  const body = fetcher.mock.calls[index]![1]!.body;
  return body instanceof FormData ? { rich_message: JSON.parse(String(body.get('rich_message'))) } : JSON.parse(String(body));
};
const rejection = () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: photo rejected' }, { status: 400 });
it('uploads exactly one pair JPEG, reuses bot-specific file_id on edit and never leaks internal fields', async () => {
  const value = screen();
  fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 71, rich_message: { blocks: [{ type: 'photo', photo: [{ file_id: 'pair-id' }] }] } } }));
  expect(await deliverScreen('customer', { chatId: 123 }, value)).toMatchObject({ status: 'sent' });
  const form = fetcher.mock.calls[0]![1]!.body as FormData;
  expect([...form.values()].filter(value => value instanceof File)).toHaveLength(1);
  expect(payload().rich_message.blocks[1].photo.media).toBe('attach://photo');
  expect(JSON.stringify(payload())).not.toMatch(/richKeyboard|mediaFallback|catalog-pair/);
  await deliverScreen('customer', { chatId: 123, messageId: 71 }, value);
  expect(fetcher.mock.calls[1]![0]).toContain('editMessageText'); expect(payload(1).rich_message.blocks[1].photo.media).toBe('pair-id');
  expect(payload(1).rich_message.blocks.filter((block: { type: string }) => block.type === 'buttons')).toHaveLength(2);
});
it.each(['missing', 'rejected', 'html', 'unknown'] as const)('keeps names/IDs/actions and avoids unknown delivery retries on %s', async mode => {
  const value = screen();
  if (mode === 'missing') vi.mocked(catalogImage).mockResolvedValue(undefined);
  if (mode === 'rejected' || mode === 'html') fetcher.mockResolvedValueOnce(rejection());
  if (mode === 'html') fetcher.mockResolvedValueOnce(rejection());
  if (mode === 'unknown') fetcher.mockRejectedValueOnce(new Error('Lost delivery response'));
  const result = await deliverScreen('customer', { chatId: 123 }, value);
  if (mode === 'unknown') { expect(result.status).toBe('unknown'); expect(fetcher).toHaveBeenCalledTimes(1); return; }
  expect(result.status).toBe('sent');
  const last = payload(fetcher.mock.calls.length - 1);
  expect(JSON.stringify(last)).toContain('Киви'); expect(JSON.stringify(last)).toContain('Слива');
  if (mode === 'html') { expect(last.reply_markup).toEqual(value.keyboard); expect(last.parse_mode).toBe('HTML'); }
  else {
    expect(last.rich_message.blocks.some((block: { type: string }) => block.type === 'photo')).toBe(false);
    expect(last.rich_message).toEqual(richMessage({ ...value, rich: { blocks: value.mediaFallback! } }));
  }
});
