// Loaded before the isolated API: fail closed on outbound HTTP, including provider SDK fetches.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const allowed = value => {
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    throw new Error('Checkout E2E blocked external HTTP');
};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  allowed(typeof input === 'string' || input instanceof URL ? input : input.url);
  return realFetch(input, init);
};
for (const transport of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = transport[method];
    transport[method] = function (input, ...args) {
      if (typeof input === 'string' || input instanceof URL) allowed(input);
      else if (!['127.0.0.1', 'localhost'].includes(input.hostname ?? input.host))
        throw new Error('Checkout E2E blocked external HTTP');
      return original.call(this, input, ...args);
    };
  }
}
syncBuiltinESMExports();
