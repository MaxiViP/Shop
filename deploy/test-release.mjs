import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('./deploy.sh', import.meta.url), 'utf8');
const functions = ['recover', 'switch_release'].map(name => {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `${name} must be defined`);
  return match[0];
}).join('\n');

for (const stopped of [false, true]) test(`failed deployment ${stopped ? 'after switch restores the previous release' : 'before stopping preserves the live release'}`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'shop-release-test-'));
  try {
    const previous = join(directory, 'previous');
    const next = join(directory, 'next');
    mkdirSync(previous); mkdirSync(next);
    writeFileSync(join(previous, 'artifact'), 'working release');
    symlinkSync(stopped ? next : previous, join(directory, 'current'));
    const script = `set -euo pipefail
source_root="$1"
previous_release="$1/previous"
services_stopped=${stopped ? 1 : 0}
units_changed=0
previous_release_valid=1
cleanup_timer_active=1
systemctl() { printf '%s\\n' "$*" >> "$source_root/actions"; }
${functions}
trap recover EXIT
exit 17
`;
    const result = spawnSync('bash', ['-c', script, 'release-test', directory], { encoding: 'utf8' });
    assert.equal(result.status, 17, result.stderr);
    assert.equal(readlinkSync(join(directory, 'current')), previous);
    assert.equal(readFileSync(join(previous, 'artifact'), 'utf8'), 'working release');
    if (stopped) {
      assert.equal(readFileSync(join(directory, 'actions'), 'utf8'), 'restart shop-api.service\nrestart shop-web.service\nstart shop-chat-cleanup.timer\n');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const scenario of ['units', 'pointer', 'bootstrap', 'restart']) test(`recovery handles ${scenario} failure without changing the database`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'shop-release-failure-'));
  try {
    for (const name of ['previous', 'next', 'units', 'unit-backup']) mkdirSync(join(directory, name));
    symlinkSync(join(directory, 'next'), join(directory, 'current'));
    if (scenario === 'pointer') mkdirSync(join(directory, '.current-next'));
    const units = ['shop-api.service', 'shop-web.service', 'shop-chat-cleanup.service'];
    for (const unit of units) {
      writeFileSync(join(directory, 'units', unit), 'new unit');
      writeFileSync(join(directory, 'unit-backup', unit), 'previous unit');
    }
    // This timer did not exist before installation, so recovery must remove only it.
    writeFileSync(join(directory, 'units', 'shop-chat-cleanup.timer'), 'new timer');
    writeFileSync(join(directory, 'database'), 'migrated database stays migrated');
    const script = `set -euo pipefail
source_root="$1"
previous_release="$1/previous"
services_stopped=1
units_changed=${scenario === 'units' ? 1 : 0}
unit_dir="$1/units"
unit_backup_dir="$1/unit-backup"
previous_release_valid=${scenario === 'bootstrap' ? 0 : 1}
cleanup_timer_active=0
systemctl() {
  printf '%s\\n' "$*" >> "$source_root/actions"
  ${scenario === 'restart' ? '[[ "$*" != "restart shop-api.service" ]]' : 'return 0'}
}
${functions}
trap recover EXIT
exit 17
`;
    const result = spawnSync('bash', ['-c', script, 'release-failure', directory], { encoding: 'utf8' });
    assert.equal(result.status, 17, result.stderr);
    assert.equal(readFileSync(join(directory, 'database'), 'utf8'), 'migrated database stays migrated');
    if (scenario === 'pointer' || scenario === 'bootstrap') {
      assert.equal(readlinkSync(join(directory, 'current')), join(directory, 'next'));
      assert.match(result.stderr, /manual recovery required/);
      assert.doesNotMatch(result.stderr, /restored previous application/);
      assert.equal(spawnSync('test', ['-e', join(directory, 'actions')]).status, 1);
    } else {
      assert.equal(readlinkSync(join(directory, 'current')), join(directory, 'previous'));
      const actions = readFileSync(join(directory, 'actions'), 'utf8');
      assert.ok(actions.includes('restart shop-api.service\nrestart shop-web.service\n'));
      assert.ok(!actions.includes('start shop-chat-cleanup.timer'));
      if (scenario === 'units') {
        for (const unit of units) assert.equal(readFileSync(join(directory, 'units', unit), 'utf8'), 'previous unit');
        assert.equal(spawnSync('test', ['-e', join(directory, 'units', 'shop-chat-cleanup.timer')]).status, 1);
        assert.ok(actions.startsWith('daemon-reload\n'));
      } else assert.match(result.stderr, /failed to restart shop-api.service/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
