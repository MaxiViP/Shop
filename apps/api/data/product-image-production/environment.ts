import { RunnerError } from './model.js';

// Deliberately no boolean/env/CLI override or injectable sandbox attestation.
// RO mounts, whole-tree cgroup limits, deploy fence and acceptance are not implemented in 5B-1.
export function requireProductionSandbox(): never {
  throw new RunnerError('SANDBOX_UNVERIFIED');
}
