import sharp from 'sharp';
import { backfill } from './backfill.js';
import { help, parseOptions } from './options.js';

if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
  console.log(help);
} else {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    // This standalone CLI does not change the API process's global Sharp settings.
    sharp.concurrency(1);
    sharp.cache({ memory: 32, files: 0, items: 50 });
    const options = parseOptions(process.argv.slice(2));
    const report = await backfill(options, {
      signal: abort.signal,
      onRun: (runId) => console.log(JSON.stringify({ event: 'run', runId })),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.stopped || report.failed ? 2 : 0;
  } catch {
    console.error(
      JSON.stringify({
        error: 'BACKFILL_REFUSED',
        message:
          'Check arguments, roots, inventory and owned run state; no unsafe fallback is available.',
      }),
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
