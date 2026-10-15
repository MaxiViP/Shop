import sharp from 'sharp';
import { requireProductionSandbox } from './environment.js';
import { RunnerError } from './model.js';
import { parseOptions } from './options.js';
import { dryRun } from './runner.js';

const help = [
  'Production image backfill preparation (5B-1). Apply is blocked until 5B-2 acceptance.',
  'Required: --inventory PATH --source-root PATH --variants-root PATH --state-root PATH',
  '--dry-run (default): read-only, no generation or state writes.',
  '--batch-size 1|5|20|50 (default 1); concurrency is always 1.',
  '--approval PATH --approval-sha256 SHA256: verify the exact approved scope.',
  '--resume RUN_ID: read-only revalidation of existing state; no automatic resume.',
  '--apply: always refused with SANDBOX_UNVERIFIED in this implementation.',
].join('\n');
if (process.argv.length === 3 && process.argv[2] === '--help')
  console.log(help);
else {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.apply) {
      if (!options.approval) throw new RunnerError('APPROVAL_REQUIRED');
      requireProductionSandbox(); // Before opening any caller-selected paths; no test/env override.
    }
    sharp.concurrency(1);
    sharp.cache({ memory: 32, files: 0, items: 50 });
    console.log(JSON.stringify(await dryRun(options), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof RunnerError ? error.code : 'RUNNER_REFUSED',
      }),
    );
    process.exitCode = 1;
  }
}
