import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const dummySalt = '00000000000000000000000000000000';
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
export async function hashAdminPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);
  return `scrypt:32768:${salt}:${hash.toString('hex')}`;
}
export async function verifyAdminPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const valid = /^scrypt:32768:[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored ?? '');
  const [, , salt, hash] = valid
    ? stored!.split(':')
    : ['', '', dummySalt, '00'.repeat(64)];
  const actual = await derive(password, salt!);
  return timingSafeEqual(actual, Buffer.from(hash!, 'hex')) && valid;
}
