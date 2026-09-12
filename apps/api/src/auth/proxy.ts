import { isIP, SocketAddress } from 'node:net';
import type { Request } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

export function trustedProxies(
  value = process.env.TRUST_PROXY,
): false | string[] {
  if (!value?.trim() || value.trim() === 'false') return false;
  const entries = value.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    const [address = '', prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (
      !family ||
      address.includes('%') ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    ) {
      throw new Error(
        'TRUST_PROXY: задайте IP/CIDR доверенных proxy или оставьте пустым; true, hop count и /0 запрещены',
      );
    }
  }
  return entries;
}

export function configureProxy(app: Pick<NestExpressApplication, 'set'>) {
  // Express/proxy-addr walks from the socket toward the first untrusted hop.
  app.set('trust proxy', trustedProxies());
}

export function clientIp(request: Pick<Request, 'ip'>) {
  const ip = request.ip;
  if (!ip || !isIP(ip)) return 'unknown';
  // Node canonicalizes IPv6 (including equivalent hex/dotted IPv4-mapped forms).
  // Never parse X-Forwarded-For here, or fall back to its leftmost value.
  const canonical = SocketAddress.parse(
    isIP(ip) === 6 ? `[${ip}]:0` : `${ip}:0`,
  )?.address;
  if (!canonical) return 'unknown';
  return canonical.startsWith('::ffff:') && isIP(canonical.slice(7)) === 4
    ? canonical.slice(7)
    : canonical;
}
