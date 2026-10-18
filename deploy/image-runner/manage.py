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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import artifact
import broker
import launcher

BASE = Path('/var/lib/korzinamarket-image-runner')
UNIT = Path('/etc/systemd/system/shop-image-runner@.service')
PIN = UNIT.with_name('shop-image-runner-pin@.target')
FENCE = Path('/run/lock/korzinamarket-deploy.lock')


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


def batch(size: int, after: str | None, image: str | None = None) -> None:
    # Hold the existing deployment lock during preparation. The supervisor takes
    # it again before apply; its FDSTORE duplicate survives failure/stop/OOM.
    fence = launcher.acquire_fence(FENCE)
    try:
        for path in (UNIT, PIN, BASE / 'manifest.json'):
            launcher.regular(path, 16 * 1024 * 1024, owner=0)
        artifact.verify(BASE / 'rootfs', json.loads((BASE / 'manifest.json').read_text()))
    except BaseException:
        os.close(fence)
        raise
    token = str(uuid.uuid4())
    requests = BASE / 'requests'
    requests.mkdir(mode=0o700, exist_ok=True)
    with os.scandir(requests) as entries:
        for count, _ in enumerate(entries):
            launcher.require(count < 1000, 'CONTROL_LIMIT')
    temporary = requests / token
    temporary.mkdir(mode=0o700)
    for name in ('request.json', 'inventory.jsonl', 'approval.json'):
        private(temporary / name, b'{}\n')
    cursor = BASE / 'cursor.json'
    if image:
        launcher.require(size == 1 and launcher.SOURCE.fullmatch(image), "INVALID_IMAGE")
        after = ""
    if after is None:
        after = json.loads(cursor.read_text()) if cursor.exists() else ''
    launcher.require(not after or launcher.SOURCE.fullmatch(after), 'INVALID_CURSOR')
    prep = f'shop-image-prepare-{token}.service'
    template = UNIT.read_text()
    lines = []
    for line in template.splitlines():
        if line.startswith('ExecStart='):
            line = f'ExecStart=/usr/bin/python3 -I -B /opt/image-runner/prepare.py {size} "{after}"'
        elif line.startswith('BindReadOnlyPaths=') and line.endswith(':/run/image-manager.sock'):
            continue
        if line.startswith("ExecStart=") and image:
            line += f' "{image}"'
        lines.append(line.replace('%i', token))
    body = '\n'.join(lines) + '\nReadOnlyPaths=+/storage\n'
    prep_path = Path('/run/systemd/system') / prep
    private(prep_path, body.encode())
    broker_name = None
    broker_fd = -1
    finished = False
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
            os.close(fence)
            fence = -1
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
        finished = True
    finally:
        if fence >= 0:
            os.close(fence)
        command('systemctl', 'stop', prep)
        if broker_name:
            command('systemctl', 'stop', broker_name)
        if broker_fd >= 0:
            os.close(broker_fd)
        if finished:
            # Only this call's empty preparation placeholders and stopped unit.
            # Frozen apply approvals, journals and all image/run locks are retained.
            for name in ('request.json', 'inventory.jsonl', 'approval.json'):
                (temporary / name).unlink()
            temporary.rmdir()
            prep_path.unlink()


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
