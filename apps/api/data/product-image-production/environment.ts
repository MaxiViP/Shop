import { inspectLauncherAdmission } from './admission.js';
import type { Options } from './options.js';

// No boolean/env override: only the root supervisor can open this request inode.
// Recheck before every publication/checkpoint as well as before reading inputs.
export function requireProductionSandbox(options: Options): void {
  inspectLauncherAdmission(options);
}
