import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { directory } from '../../src/product/image-storage.js';
import { equal, RunnerError } from './model.js';
import type { Options } from './options.js';

export interface Fixture {
  readonly root: string;
  readonly paths: Readonly<
    Pick<
      Options,
      'sourceRoot' | 'variantsRoot' | 'stateRoot' | 'inventory' | 'approval'
    >
  >;
}
const issued = new WeakMap<
  Fixture,
  { paths: Fixture['paths']; identities: string[]; parent: string }
>();
const identity = async (path: string) => {
  const info = await directory(path);
  return `${info.dev}:${info.ino}`;
};

// No caller-selected paths, no adoption of pre-existing workspaces, no CLI override.
export async function createFixture(): Promise<Fixture> {
  const parent = resolve(tmpdir());
  if (
    process.env.NODE_ENV === 'production' ||
    /^\/(?:var\/lib|opt|etc)(?:\/|$)/.test(parent)
  )
    throw new RunnerError('FIXTURE_ONLY');
  await directory(parent); // Reject symlink/junction ancestors before the first mkdir/write.
  const root = await mkdtemp(join(parent, 'korzina-image-production-fixture-'));
  const paths = Object.freeze({
    sourceRoot: join(root, 'source'),
    variantsRoot: join(root, 'variants'),
    stateRoot: join(root, 'state'),
    inventory: join(root, 'inventory.jsonl'),
    approval: join(root, 'approval.json'),
  });
  for (const path of [paths.sourceRoot, paths.variantsRoot, paths.stateRoot])
    await mkdir(path, { mode: 0o700 });
  const fixture = Object.freeze({ root, paths });
  issued.set(fixture, {
    paths: { ...paths },
    parent,
    identities: await Promise.all(
      [root, paths.sourceRoot, paths.variantsRoot, paths.stateRoot].map(
        identity,
      ),
    ),
  });
  return fixture;
}

export async function assertFixture(fixture: Fixture, options: Options) {
  const record = issued.get(fixture);
  if (
    !record ||
    process.env.NODE_ENV === 'production' ||
    dirname(fixture.root) !== record.parent
  )
    throw new RunnerError('FIXTURE_ONLY');
  for (const key of [
    'sourceRoot',
    'variantsRoot',
    'stateRoot',
    'inventory',
  ] as const)
    if (options[key] !== record.paths[key])
      throw new RunnerError('FIXTURE_ONLY');
  if (options.approval && options.approval !== record.paths.approval)
    throw new RunnerError('FIXTURE_ONLY');
  const current = await Promise.all(
    [
      fixture.root,
      options.sourceRoot,
      options.variantsRoot,
      options.stateRoot,
    ].map(identity),
  );
  if (!equal(record.identities, current)) throw new RunnerError('FIXTURE_ONLY');
}
