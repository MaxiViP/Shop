"""Real operator CLI + production launcher in the existing disposable Linux VM."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import application
import artifact
import launcher


def run(root: Path, manifest: dict[str, object]) -> None:
    assert Path('/etc/image-acceptance-disposable').read_text() == 'isolated-image-fixtures-v1\n'
    repo = Path(__file__).resolve().parents[2]
    base = Path('/var/lib/korzinamarket-image-runner')
    assert not base.exists()
    base.mkdir(mode=0o755)
    shutil.move(root / 'rootfs', base / 'rootfs')
    (base / 'manifest.json').write_text(json.dumps(manifest))
    application.command('groupadd', '-g', '55001', 'shop')
    application.command('useradd', '-u', '997', '-g', '55001', '-M', '-s', '/usr/sbin/nologin', 'shop')
    tools = Path('/opt/image-runner')
    tools.mkdir(mode=0o755)
    for name in ('manage.py', 'broker.py', 'launcher.py', 'artifact.py'):
        shutil.copyfile(repo / 'deploy/image-runner' / name, tools / name)
        (tools / name).chmod(0o555)
    for name in ('shop-image-runner@.service', 'shop-image-runner-pin@.target'):
        shutil.copyfile(repo / 'deploy' / name, Path('/etc/systemd/system') / name)
    storage = Path('/var/lib/korzinamarket/uploads')
    storage.mkdir(parents=True, mode=0o755)
    for name in ('products', 'product-variants', '.product-image-state', 'chat'):
        path = storage / name
        path.mkdir(mode=0o700)
        os.chown(path, 997, 55001)
    fence = Path('/run/lock/korzinamarket-deploy.lock')
    fence.write_text('disposable production CLI fence\n')
    fence.chmod(0o600)
    # Native Sharp fixture source; three distinct target dimensions, no mock encoder.
    image = subprocess.check_output([
        'chroot', str(base / 'rootfs'), '/usr/bin/node', '-e',
        "const sharp=require('/artifact/apps/api/node_modules/sharp');"
        "sharp({create:{width:960,height:720,channels:3,background:'#5a83ad'}})"
        ".webp().toBuffer().then(b=>process.stdout.write(b))",
    ], timeout=30)
    first = '550e8400-e29b-41d4-a716-446655440001.webp'
    second = '550e8400-e29b-41d4-a716-446655440002.webp'

    def original(name: str) -> None:
        path = storage / 'products' / name
        path.write_bytes(image)
        path.chmod(0o600)
        os.chown(path, 997, 55001)

    def fingerprint() -> str:
        data = []
        for path in sorted((storage / 'products').iterdir()):
            info = path.stat()
            data.append([path.name, info.st_ino, info.st_mtime_ns, info.st_mode, artifact.sha(path)])
        return hashlib.sha256(json.dumps(data).encode()).hexdigest()

    def call(*args: str) -> str:
        child = subprocess.run(['/usr/bin/python3', '-I', str(tools / 'manage.py'), *args],
                               capture_output=True, text=True, timeout=650,
                               env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        print('PRODUCTION_CLI_LOG=' + child.stdout + child.stderr, flush=True)
        if child.returncode:
            for journal in (storage / '.product-image-state/production-runs').glob('*/journal.jsonl'):
                print('PRODUCTION_FAILED_JOURNAL=' + journal.read_text(), flush=True)
        assert child.returncode == 0, child.returncode
        return child.stdout

    original(first)
    before = fingerprint()
    call('batch', '--size', '1', '--image', first)
    assert fingerprint() == before
    ready = json.loads((storage / '.product-image-state/ready' / (first[:-5] + '.json')).read_text())
    assert sorted(item['width'] for item in ready['candidates']) == [192, 384, 640]
    assert all((storage / 'product-variants' / item['url'].removeprefix('/uploads/products/')).is_file()
               for item in ready['candidates'])
    # New upload/import is discovered without HTTP hooks or a database.
    original(second)
    before = fingerprint()
    call('batch', '--size', '5', '--after', '')
    assert fingerprint() == before
    assert (storage / '.product-image-state/ready' / (second[:-5] + '.json')).is_file()
    files = {str(path): artifact.sha(path) for path in (storage / 'product-variants').rglob('*.webp')}
    call('batch', '--size', '1', '--image', first)
    assert files == {str(path): artifact.sha(path) for path in (storage / 'product-variants').rglob('*.webp')}
    artifact.verify(base / 'rootfs', manifest)
    fd = launcher.acquire_fence(fence)
    os.close(fd)
    print('PRODUCTION_RESULT=' + json.dumps({
        'status': 'passed', 'canary': True, 'newUploadDiscovery': True,
        'webpWidths': [192, 384, 640], 'originalsUnchanged': True,
        'repeatNoWrites': True, 'immutableArtifact': True, 'fenceReleasedAfterQuiescence': True,
        'uid': 997, 'gid': 55001,
    }), flush=True)
