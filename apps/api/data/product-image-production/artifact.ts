import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { hash, readBounded } from '../../src/product/image-storage.js';
import { jsonBytes, RunnerError } from './model.js';

// Source artifact identity for 5B-1. No caller-supplied revision or environment assertion.
// A packaged, immutable Linux artifact and native binary attestation remain 5B-2 gates.
const files = [
  'artifact.ts',
  'model.ts',
  'options.ts',
  'input.ts',
  'state.ts',
  'runner.ts',
  'environment.ts',
  'run.ts',
  'fixture.ts',
  '../product-image-variants/files.ts',
  '../product-image-variants/encoder.ts',
  '../product-image-variants/worker.ts',
  '../../src/product/image-storage.ts',
  '../../src/product/image-manifest.ts',
  '../../src/product/image-variants.ts',
  '../../package.json',
  '../../../../pnpm-lock.yaml',
];
export async function artifactIdentity() {
  const sources: { name: string; sha256: string }[] = [];
  for (const name of files) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    const file = await readBounded(
      dirname(path),
      [basename(path)],
      4 * 1024 * 1024,
    );
    if (!file) throw new RunnerError('ARTIFACT_MISMATCH');
    sources.push({ name, sha256: file.sha256 });
  }
  const runtime = {
    node: process.versions.node,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
  };
  return { sha256: hash(jsonBytes({ sources, ...runtime })), ...runtime };
}
