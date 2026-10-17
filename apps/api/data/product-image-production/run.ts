import sharp from 'sharp';
import { requireProductionSandbox } from './environment.js';
import { inspectLauncherDryRunHandoff } from './admission.js';
import { RunnerError } from './model.js';
import { parseOptions } from './options.js';
import { dryRun, runProduction } from './runner.js';

const help = [
  'Bounded offline product image processing through the Linux root supervisor.',
  'Required: --inventory PATH --source-root PATH --variants-root PATH --state-root PATH',
  '--dry-run (default): read-only, no generation or state writes.',
  '--batch-size 1|5|20|50 (default 1); concurrency is always 1.',
  '--approval PATH --approval-sha256 SHA256: verify the exact approved scope.',
  '--resume RUN_ID: read-only revalidation of existing state; no automatic resume.',
  '--apply: requires the verified root launcher handoff; direct invocation is refused.',
].join('\n');
if (process.argv.length === 3 && process.argv[2] === '--help')
  console.log(help);
else {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.apply) {
      if (!options.approval) throw new RunnerError('APPROVAL_REQUIRED');
      requireProductionSandbox(options); // Before opening caller-selected paths.
    }
    // Inspection and apply use distinct request kinds on the same root-only FD
    // handoff. A direct dry-run remains read-only without a launcher credential.
    if (!options.apply && process.env.KORZINA_IMAGE_ADMISSION_FD !== undefined)
      inspectLauncherDryRunHandoff(options);
    sharp.concurrency(1);
    sharp.cache({ memory: 32, files: 0, items: 50 });
    const report = options.apply
      ? await runProduction(options, abort.signal)
      : await dryRun(options);
    console.log(JSON.stringify(report));
    if ('stopped' in report && (report.stopped || report.failed)) process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof RunnerError ? error.code : 'RUNNER_REFUSED',
      }),
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
