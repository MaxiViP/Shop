// Read-only proposal for one newly created synthetic WebP; never apply/backfill.
import { parseOptions } from '/artifact/apps/api/data/product-image-production/options.ts';
import { dryRun } from '/artifact/apps/api/data/product-image-production/runner.ts';
const options = parseOptions(['--dry-run', '--inventory', '/input/inventory.jsonl',
  '--source-root', '/storage/products', '--variants-root', '/storage/product-variants',
  '--state-root', '/storage/.product-image-state', '--batch-size', '1']);
const report = await dryRun(options);
if (report.mode !== 'dry-run' || report.eligible !== 1) throw new Error('synthetic proposal refused');
console.log('LAUNCHER_PROPOSAL=' + JSON.stringify(report.proposal));
