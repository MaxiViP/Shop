import { createHmac } from 'node:crypto';

export function signedInitData(
  token: string,
  user: Record<string, unknown> = { id: 123, first_name: 'Test' },
  fields: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
    ...fields,
  });
  params.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret)
    .update([...params].map(([k, v]) => k + '=' + v).join('\n'))
    .digest('hex');
  params.set('hash', hash);
  return params.toString();
}
