import { createGateway, host, port } from './server.js';

const server = createGateway({ tokens: {
  customer: process.env.TELEGRAM_CUSTOMER_BOT_TOKEN,
  staff: process.env.TELEGRAM_STAFF_BOT_TOKEN,
} });
server.on('error', () => {
  // Never pass Error objects, environment, upstream URLs or request data to logging.
  process.stderr.write('Telegram gateway server failed\n');
  process.exitCode = 1;
});
server.listen(port, host);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  server.close();
  setTimeout(() => process.exit(0), 10000).unref();
});
