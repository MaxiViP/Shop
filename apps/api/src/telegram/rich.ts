// Supported Bot API 10.3 subset. Outgoing blocks use InputRichBlock, not received media objects.
export type ButtonStyle = 'primary' | 'success' | 'danger';
export type TelegramButton = { text: string; style?: ButtonStyle } & (
  { callback_data: string } | { url: string } | { web_app: { url: string } } | { copy_text: { text: string } } | { disabled: Record<string, never> });
export type TelegramKeyboard = { inline_keyboard: TelegramButton[][] };
export type RichText = string | RichText[] | { type: 'bold' | 'italic' | 'marked'; text: RichText };
export type RichMessageButton = TelegramButton;
type Cell = { text: RichText; align: 'left' | 'right'; valign: 'top'; is_header?: true };
export type InputRichBlock =
  | { type: 'heading'; text: RichText; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: 'paragraph' | 'footer'; text: RichText }
  | { type: 'divider' }
  | { type: 'buttons'; buttons: RichMessageButton[]; align?: 'left' | 'center' | 'right' }
  | { type: 'table'; cells: Cell[][]; is_compact?: true }
  | { type: 'details'; summary: RichText; blocks: InputRichBlock[]; is_open?: true }
  | { type: 'photo'; photo: { type: 'photo'; media: string }; caption?: { text: RichText } };
export type InputRichMessage = { blocks: InputRichBlock[]; skip_entity_detection?: boolean };
export type TelegramScreen = { text: string; keyboard: TelegramKeyboard; rich?: InputRichMessage; fallback?: RichText[]; mediaReason?: 'no_image' | 'invalid_url' };

export const bold = (text: string): RichText => ({ type: 'bold', text });
export const marked = (text: string): RichText => ({ type: 'marked', text });
export const paragraph = (text: RichText): InputRichBlock => ({ type: 'paragraph', text });
export const heading = (text: string): InputRichBlock => ({ type: 'heading', text, size: 2 });
export function screenNotice(screen: TelegramScreen, notice: string): TelegramScreen {
  return { ...screen, text: notice + '\n\n' + screen.text,
    ...(screen.fallback ? { fallback: [bold(notice), '', ...screen.fallback] } : {}),
    ...(screen.rich ? { rich: { ...screen.rich, blocks: [paragraph(bold(notice)), ...screen.rich.blocks] } } : {}) };
}
export function richTable(rows: readonly (readonly [string, string])[]): InputRichBlock {
  return { type: 'table', is_compact: true, cells: rows.map(([label, value]) => [
    { text: label, align: 'left', valign: 'top' }, { text: bold(value), align: 'right', valign: 'top' },
  ]) };
}
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function html(text: RichText): string {
  if (typeof text === 'string') return escape(text);
  if (Array.isArray(text)) return text.map(html).join('');
  const tag = text.type === 'italic' ? 'i' : 'b';
  return '<' + tag + '>' + html(text.text) + '</' + tag + '>';
}
export function fallbackHtml(text: string, formatted?: RichText[]) {
  if (formatted) return formatted.map(html).join('\n');
  const [title = '', ...lines] = text.split('\n');
  return '<b>' + escape(title) + '</b>' + (lines.length ? '\n' + lines.map(escape).join('\n') : '');
}
export function richMessage(screen: TelegramScreen): InputRichMessage {
  const [title = '', ...rest] = screen.text.split('\n');
  const blocks = screen.rich?.blocks ?? [heading(title), ...(rest.some(Boolean) ? [{ type: 'divider' as const }] : []),
    ...rest.join('\n').split('\n\n').filter(Boolean).map(text => paragraph(emphasis(text)))];
  const embedded = new Set(blocks.filter(block => block.type === 'buttons').map(block => JSON.stringify(block.buttons)));
  return { blocks: [...blocks, ...screen.keyboard.inline_keyboard.filter(row => row.length && !embedded.has(JSON.stringify(row))).map(buttons => ({
    type: 'buttons' as const, buttons,
  }))], skip_entity_detection: true };
}
function emphasis(text: string): RichText {
  const parts: RichText[] = [];
  let start = 0;
  for (const match of text.matchAll(/(?:≈[ \u00a0\u202f]*)?[+−-]?\d[\d \u00a0\u202f.,]*[ \u00a0\u202f]₽/gu)) {
    if (match.index > start) parts.push(text.slice(start, match.index));
    parts.push(bold(match[0])); start = match.index + match[0].length;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts.length ? parts : text;
}
export function validScreen(screen: TelegramScreen): boolean {
  const rows = screen.keyboard.inline_keyboard;
  return screen.text.length > 0 && screen.text.length <= 4096 && rows.length <= 32 && rows.every(row => row.length <= 8 && row.every(button => {
    if (!button.text || button.text.length > 180) return false;
    if ('callback_data' in button) return Buffer.byteLength(button.callback_data) > 0 && Buffer.byteLength(button.callback_data) <= 64;
    if ('copy_text' in button) return button.copy_text.text.length > 0 && button.copy_text.text.length <= 256;
    if ('disabled' in button) return Object.keys(button.disabled).length === 0;
    try {
      const url = new URL('url' in button ? button.url : button.web_app.url);
      return ['https:', 'http:', 'tg:', 'tel:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  })) && richMessage(screen).blocks.length <= 40 && Buffer.byteLength(JSON.stringify(richMessage(screen))) <= 48 * 1024;
}

// Only public media from the configured shop origin. No arbitrary URL or API fetch.
export function productPhoto(path: string | undefined): InputRichBlock | undefined {
  if (!path) return;
  try {
    const origin = new URL(process.env.ORDER_SITE_URL ?? '');
    const url = new URL(path, origin);
    if (origin.protocol !== 'https:' || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(origin.hostname) || url.origin !== origin.origin || url.username || url.password || url.search || url.hash ||
      !/^\/(?:uploads\/|product-images\/)/.test(url.pathname)) return;
    return { type: 'photo', photo: { type: 'photo', media: url.href } };
  } catch { return; }
}
