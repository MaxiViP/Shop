"""Root operator entry point: bounded discovery/apply and quiescence-only fence release.

Fixed local paths, no database, secrets, queue, force/unlock, GC or original writes.
Install beside launcher/broker/artifact.py in /opt/image-runner, root-owned 0555.
"""
from __future__ import annotations

import argparse
import json
import os
import pwd
from pathlib import Path
import subprocess
import sys
import time
import uuid
from typing import BinaryIO

sys.path.insert(0, str(Path(__file__).resolve().parent))
import artifact
import broker
import launcher

BASE = Path('/var/lib/korzinamarket-image-runner')
UNIT = Path('/etc/systemd/system/shop-image-runner@.service')
PIN = UNIT.with_name('shop-image-runner-pin@.target')
FENCE = Path('/run/lock/korzinamarket-deploy.lock')
RUNTIME = Path('/run/systemd/system')


def command(*args: str, timeout: int = 30) -> str:
    result = subprocess.run(args, check=True, capture_output=True, text=True,
                            stdin=subprocess.DEVNULL, timeout=timeout,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    launcher.require(len(result.stdout) <= 512 * 1024, 'OUTPUT_LIMIT')
    return result.stdout


def private(path: Path, data: bytes, reader_gid: int | None = None) -> None:
    with path.open('xb') as stream:
        if reader_gid is not None:
            os.fchown(stream.fileno(), 0, reader_gid)
        os.fchmod(stream.fileno(), 0o600 if reader_gid is None else 0o640)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def wait(unit: str) -> dict[str, str]:
    deadline = time.monotonic() + 650
    while time.monotonic() < deadline:
        state = launcher.show(unit)
        if state.get('ActiveState') in ('inactive', 'failed'):
            return state
        time.sleep(0.25)
    raise launcher.Refused('UNIT_TIMEOUT_FENCE_RETAINED')


def release(instance: str) -> None:
    launcher.require(launcher.UUID.fullmatch(instance) is not None, 'INVALID_INSTANCE')
    unit, pin = broker.names(instance)
    state = launcher.show(unit)
    launcher.require(state.get('LoadState') == 'loaded' and
                     state.get('ActiveState') in ('inactive', 'failed') and
                     state.get('MainPID') == '0' and state.get('NRestarts') == '0',
                     'NOT_QUIESCENT')
    group = state.get('ControlGroup', '')
    launcher.require(group in ('', f'/system.slice/{unit}'), 'CGROUP_UNVERIFIED')
    location = Path('/sys/fs/cgroup/system.slice') / unit
    if location.exists():
        launcher.require('populated 0' in (location / 'cgroup.events').read_text().splitlines(),
                         'NOT_QUIESCENT')
        launcher.require(not (location / 'cgroup.procs').read_text().strip(), 'NOT_QUIESCENT')
    # Never unlink per-source/run locks. A failed batch still needs forensic review.
    command('systemctl', 'clean', '--what=fdstore', unit)
    override = Path('/run/systemd/system') / (pin + '.d')
    override.mkdir(mode=0o755, exist_ok=False)
    private(override / 'release.conf', b'[Unit]\nRefuseManualStop=no\n')
    command('systemctl', 'daemon-reload')
    command('systemctl', 'stop', pin)
    print(json.dumps({'released': instance, 'imageLocksUntouched': True}), flush=True)


def preparation_body(template: str, token: str, size: int, after: str, image: str | None) -> str:
    lines = []
    for line in template.splitlines():
        if line.startswith('ExecStart='):
            line = f'ExecStart=/usr/bin/python3 -I -B /opt/image-runner/prepare.py {size} "{after}"'
            if image:
                line += f' "{image}"'
        elif line.startswith('BindReadOnlyPaths=') and (
            ':/run/image-manager.sock' in line or ':/input/' in line
        ):
            continue  # Read-only discovery needs neither apply inputs nor broker.
        elif line.startswith('FileDescriptorStoreMax='):
            line = 'FileDescriptorStoreMax=0'
        elif line.startswith('FileDescriptorStorePreserve='):
            line = 'FileDescriptorStorePreserve=no'
        lines.append(line.replace('%i', token))
    return '\n'.join(lines) + '\nReadOnlyPaths=+/storage\n'


def finish_preparation(path: Path, body: bytes, evidence: Path) -> None:
    """Only this invocation's unit; evidence precedes exact-unit reset/unlink.

    A timeout, unknown cgroup, changed unit or failed evidence write retains the
    unit for review. No request, image lock, runner pin or FD store is removed.
    """
    initial = launcher.show(path.name)
    if initial.get('ActiveState') not in ('inactive', 'failed'):
        command('systemctl', 'stop', path.name)
    state = launcher.show(path.name)
    launcher.require(state.get('LoadState') == 'loaded' and
                     state.get('ActiveState') in ('inactive', 'failed') and
                     state.get('MainPID') == '0' and state.get('NRestarts') == '0' and
                     state.get('NFileDescriptorStore') == '0', 'PREP_NOT_QUIESCENT')
    group = state.get('ControlGroup', '')
    launcher.require(group in ('', f'/system.slice/{path.name}'), 'CGROUP_UNVERIFIED')
    location = Path('/sys/fs/cgroup/system.slice') / path.name
    if location.exists():
        launcher.require('populated 0' in (location / 'cgroup.events').read_text().splitlines()
                         and not (location / 'cgroup.procs').read_text().strip(), 'PREP_NOT_QUIESCENT')
    launcher.regular(path, 65536, owner=0)
    launcher.require(path.read_bytes() == body, 'PREP_UNIT_CHANGED')
    journal = command('journalctl', '-u', path.name, '-o', 'json', '--no-pager').encode()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, data in (('unit.service', body), ('journal.jsonl', journal),
                       ('state.json', (json.dumps({'beforeStop': initial, 'afterStop': state},
                                                sort_keys=True) + '\n').encode())):
        private(evidence / name, data)
    checksums = {item.name: artifact.sha(item) for item in evidence.iterdir()}
    private(evidence / 'sha256.json', (json.dumps(checksums, sort_keys=True) + '\n').encode())
    # Persist the new evidence directory entries too, before forgetting failure.
    for parent in (evidence.parent, evidence.parent.parent):
        fd = os.open(parent, os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    # Successful inactive units can be garbage-collected between manager calls.
    # Only failed units retain failure state and require an explicit reset.
    if state.get('ActiveState') == 'failed':
        command('systemctl', 'reset-failed', path.name)
    path.unlink()
    command('systemctl', 'daemon-reload')


def batch(size: int, after: str | None, image: str | None = None) -> None:
    # Hold the existing deployment lock during preparation. The supervisor takes
    # it again before apply; its FDSTORE duplicate survives failure/stop/OOM.
    with os.fdopen(launcher.acquire_fence(FENCE), 'rb') as fence:
        for path in (UNIT, PIN, BASE / 'manifest.json'):
            launcher.regular(path, 16 * 1024 * 1024, owner=0)
        artifact.verify(BASE / 'rootfs', json.loads((BASE / 'manifest.json').read_text()))
        prepare_batch(size, after, image, fence)


def prepare_batch(size: int, after: str | None, image: str | None, fence: BinaryIO) -> None:
    token = str(uuid.uuid4())
    requests = BASE / 'requests'
    requests.mkdir(mode=0o700, exist_ok=True)
    with os.scandir(requests) as entries:
        for count, _ in enumerate(entries, start=1):
            launcher.require(count < 1000, 'CONTROL_LIMIT')
    cursor = BASE / 'cursor.json'
    if image:
        launcher.require(size == 1 and launcher.SOURCE.fullmatch(image), "INVALID_IMAGE")
        after = ""
    if after is None:
        after = json.loads(cursor.read_text()) if cursor.exists() else ''
    launcher.require(not after or launcher.SOURCE.fullmatch(after), 'INVALID_CURSOR')
    prep = f'shop-image-prepare-{token}.service'
    body = preparation_body(UNIT.read_text(), token, size, after, image).encode()
    prep_path = RUNTIME / prep
    private(prep_path, body)
    broker_name = None
    broker_fd = -1
    try:
        command('systemctl', 'daemon-reload')
        command('systemctl', 'start', prep)
        prepared = wait(prep)
        if prepared.get('Result') != 'success':
            print(command('journalctl', '-u', prep, '-o', 'cat', '--no-pager'), file=sys.stderr)
        launcher.require(prepared.get('Result') == 'success', 'PREPARATION_FAILED')
        log = command('journalctl', '-u', prep, '-o', 'cat', '--no-pager')
        reports = [json.loads(line.split('=', 1)[1]) for line in log.splitlines()
                   if line.startswith('IMAGE_PREPARE=')]
        launcher.require(len(reports) == 1, 'PREPARATION_FAILED')
        report = reports[0]
        if report['batch'] is None:
            print(json.dumps({'scanned': report['scanned'], 'next': report['next'], 'processed': 0}))
        else:
            selected = report['batch']
            approval = selected['proposal']
            instance = approval['runId']
            launcher.require(launcher.UUID.fullmatch(instance), 'INVALID_INSTANCE')
            target = requests / instance
            target.mkdir(mode=0o700)
            reader_gid = pwd.getpwnam('shop').pw_gid
            private(target / 'inventory.jsonl', selected['inventory'].encode(), reader_gid)
            private(target / 'approval.json', (json.dumps(approval) + '\n').encode(), reader_gid)
            broker_name, identity, broker_fd = broker.start(instance)
            request = {
                'schemaVersion': 1, 'kind': 'image-production-apply', 'runId': instance,
                'batchSize': approval['batchSize'], 'managerBroker': identity,
                'inventorySha256': artifact.sha(target / 'inventory.jsonl'),
                'approvalSha256': artifact.sha(target / 'approval.json'),
                'launcherSha256': artifact.sha(BASE / 'rootfs/opt/image-runner/launcher.py'),
                'unitSha256': artifact.sha(UNIT), 'pinSha256': artifact.sha(PIN),
            }
            private(target / 'request.json', (json.dumps(request) + '\n').encode())
            broker.bind(instance, target / 'request.json', UNIT, PIN)
            print(json.dumps({'runId': instance, 'approvalSha256': request['approvalSha256'],
                              'batchSize': approval['batchSize']}), flush=True)
            fence.close()
            command('systemctl', 'start', f'shop-image-runner-pin@{instance}.target')
            completed = wait(f'shop-image-runner@{instance}.service')
            print(command('journalctl', '-u', f'shop-image-runner@{instance}.service',
                          '-o', 'cat', '--no-pager'), end='', flush=True)
            launcher.require(completed.get('Result') == 'success' and
                             completed.get('ExecMainStatus') == '0', 'APPLY_FAILED_FENCE_RETAINED')
            release(instance)
        # Cursor advances only after a successful batch; a wrap discovers new uploads.
        if not image:
            new_cursor = BASE / ('cursor-' + token + '.json')
            private(new_cursor, json.dumps(report['next']).encode())
            os.replace(new_cursor, cursor)
        print(json.dumps({'next': report['next'], 'scanned': report['scanned']}), flush=True)
    finally:
        try:
            finish_preparation(prep_path, body, BASE / 'preparations' / token)
        finally:
            try:
                if broker_name:
                    command('systemctl', 'stop', broker_name)
            finally:
                if broker_fd >= 0:
                    os.close(broker_fd)


if __name__ == '__main__':
    launcher.require(sys.platform == 'linux' and os.geteuid() == 0, 'ROOT_LINUX_REQUIRED')
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    process = sub.add_parser('batch')
    process.add_argument('--size', type=int, choices=(1, 5, 20, 50), default=1)
    process.add_argument('--after', help='Explicit filename cursor; empty starts from the beginning')
    process.add_argument('--image', help='One original UUID.webp for a canary or repair (size 1)')
    unlock = sub.add_parser('release')
    unlock.add_argument('instance')
    args = parser.parse_args()
    # Serialize operator calls without touching or replacing the deployment fence.
    admin = Path('/run/lock/korzinamarket-image-admin.lock')
    try:
        created = os.open(admin, os.O_RDONLY | os.O_CREAT | os.O_EXCL |
                          os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    except FileExistsError:
        pass
    else:
        os.close(created)
    lock = launcher.acquire_fence(admin)
    try:
        if args.mode == 'batch':
            batch(args.size, args.after, args.image)
        else:
            release(args.instance)
    finally:
        os.close(lock)
