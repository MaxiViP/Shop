import sharp from 'sharp';
import { generateImageVariants } from '../../src/product/image-variants.js';

sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 50 });
let started = false;
const report = () => {
  const cpu = process.cpuUsage();
  process.send?.({
    type: 'usage',
    peakRss: Math.max(
      process.memoryUsage().rss,
      process.resourceUsage().maxRSS * 1024,
    ),
    cpuMs: (cpu.user + cpu.system) / 1000,
  });
};
const timer = setInterval(report, 100);
timer.unref();
process.once('message', async (message: unknown) => {
  if (started) return;
  started = true;
  report();
  let response: unknown;
  try {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('source' in message) ||
      !Buffer.isBuffer(message.source)
    )
      throw new Error('Invalid input');
    response = {
      type: 'result',
      result: await generateImageVariants(message.source),
    };
  } catch {
    response = { type: 'invalid' };
  }
  clearInterval(timer);
  report();
  process.send?.(response, () => process.disconnect());
});
