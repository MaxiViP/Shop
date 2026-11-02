"""Native Linux control lifecycle; never touches a host service or image root."""
import contextlib
import io
import hashlib
import uuid
import json
import stat
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import ANY, call, patch


@unittest.skipUnless(sys.platform == 'linux', 'Linux control lifecycle')
class ManageTests(unittest.TestCase):
    def test_readable_inputs_do_not_make_the_admission_request_readable(self) -> None:
        import manage
        with tempfile.TemporaryDirectory(prefix='image-input-mode-test-') as name:
            root = Path(name)
            with patch.object(manage.os, 'fchown') as ownership:
                manage.private(root / 'inventory.jsonl', b'public image inventory', 55001)
                manage.private(root / 'request.json', b'root-only admission')
                ownership.assert_called_once_with(ANY, 0, 55001)
            self.assertEqual(stat.S_IMODE((root / 'inventory.jsonl').stat().st_mode), 0o640)
            self.assertEqual(stat.S_IMODE((root / 'request.json').stat().st_mode), 0o600)

    def test_live_unit_cannot_release_a_fence(self) -> None:
        import manage
        with patch.object(manage.launcher, 'show', return_value={
            'LoadState': 'loaded', 'ActiveState': 'active', 'MainPID': '123', 'NRestarts': '0',
        }), patch.object(manage, 'command') as command:
            with self.assertRaisesRegex(manage.launcher.Refused, 'NOT_QUIESCENT'):
                manage.release('550e8400-e29b-41d4-a716-446655440001')
            command.assert_not_called()

    def test_quiescence_and_release_order(self) -> None:
        import manage
        instance = '550e8400-e29b-41d4-a716-446655440001'
        unit, pin = manage.broker.names(instance)
        with tempfile.TemporaryDirectory(prefix='image-release-test-') as name:
            root = Path(name)
            group, runtime = root / 'cgroup' / unit, root / 'runtime'
            group.mkdir(parents=True)
            runtime.mkdir()
            events = group / 'cgroup.events'
            events.write_text('populated 1\n')
            (group / 'cgroup.procs').write_text('123\n')
            lock = root / 'unknown.lock'
            lock.write_bytes(b'unknown owner; retain')
            state = {'LoadState': 'loaded', 'ActiveState': 'failed', 'MainPID': '0',
                     'NRestarts': '0', 'ControlGroup': '/system.slice/' + unit}
            def paths(value: str) -> Path:
                return {'/sys/fs/cgroup/system.slice': root / 'cgroup',
                        '/run/systemd/system': runtime}.get(value, Path(value))
            with patch.object(manage, 'Path', side_effect=paths), \
                 patch.object(manage.launcher, 'show', return_value=state), \
                 patch.object(manage, 'command') as command, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(manage.launcher.Refused, 'NOT_QUIESCENT'):
                    manage.release(instance)
                command.assert_not_called()
                events.write_text('populated 0\n')
                (group / 'cgroup.procs').write_text('')
                manage.release(instance)
                self.assertEqual([call.args for call in command.call_args_list], [
                    ('systemctl', 'clean', '--what=fdstore', unit),
                    ('systemctl', 'daemon-reload'), ('systemctl', 'stop', pin),
                ])
                self.assertEqual(lock.read_bytes(), b'unknown owner; retain')

    def test_idle_discovery_does_not_accumulate_preparation_files(self) -> None:
        import manage
        with tempfile.TemporaryDirectory(prefix='image-control-test-') as name:
            root = Path(name)
            runtime = root / 'runtime'
            runtime.mkdir()
            for name in ('runner.service', 'pin.target', 'manifest.json', 'fence'):
                (root / name).write_text('{}')
                (root / name).chmod(0o600)
            report = 'IMAGE_PREPARE=' + json.dumps({'next': '', 'scanned': 0, 'batch': None})
            def command(*args: str) -> str:
                return report if args[0] == 'journalctl' else ''
            with patch.object(manage, 'BASE', root), \
                 patch.object(manage, 'UNIT', root / 'runner.service'), \
                 patch.object(manage, 'PIN', root / 'pin.target'), \
                 patch.object(manage, 'FENCE', root / 'fence'), \
                 patch.object(manage, 'RUNTIME', runtime), \
                 patch.object(manage, 'Path', side_effect=lambda value: runtime if value == '/run/systemd/system' else Path(value)), \
                 patch.object(manage.artifact, 'verify'), \
                 patch.object(manage.launcher, 'regular', side_effect=lambda path, *args, **kwargs: path.lstat()), \
                 patch.object(manage, 'wait', return_value={'Result': 'success'}), \
                 patch.object(manage.launcher, 'show', return_value={
                     'LoadState': 'loaded', 'ActiveState': 'inactive', 'MainPID': '0',
                     'NRestarts': '0', 'NFileDescriptorStore': '0', 'ControlGroup': '',
                 }), \
                 patch.object(manage, 'command', side_effect=command) as commands, \
                 contextlib.redirect_stdout(io.StringIO()):
                manage.batch(1, '')
                self.assertEqual(list((root / 'requests').iterdir()), [])
                self.assertEqual(list(runtime.iterdir()), [])
                self.assertEqual(json.loads((root / 'cursor.json').read_text()), '')
                self.assertFalse(any('reset-failed' in item.args or 'stop' in item.args
                                     for item in commands.call_args_list))

    def test_repeated_failures_preserve_evidence_without_requests(self) -> None:
        import manage
        with tempfile.TemporaryDirectory(prefix='image-failure-test-') as name:
            root = Path(name).resolve()
            runtime = root / 'runtime'
            runtime.mkdir()
            (root / 'runner.service').write_text('[Service]\nExecStart=old\n')
            (root / 'pin.target').write_text('fixture')
            (root / 'manifest.json').write_text('{}')
            fence = root / 'fence'
            fence.write_bytes(b'fence inode must survive')
            fence.chmod(0o600)
            before = fence.stat()
            locks = root / 'image.lock'
            locks.write_bytes(b'unknown owner')
            requests = root / 'requests'
            requests.mkdir()
            # Reproduce the incident: 982 placeholders + 19 filled requests.
            empty = []
            for index in range(1001):
                path = requests / str(uuid.UUID(int=index + 1, version=4))
                path.mkdir()
                for item in ('request.json', 'inventory.jsonl', 'approval.json'):
                    (path / item).write_bytes(b'{}\n' if index < 982 else b'filled approval evidence')
                if index < 982:
                    empty.append(path)
            filled = {str(path): path.read_bytes() for path in requests.glob('*/*')
                      if path.parent not in empty}
            commands = []
            state = {'LoadState': 'loaded', 'ActiveState': 'failed', 'MainPID': '0',
                     'NRestarts': '0', 'NFileDescriptorStore': '0', 'ControlGroup': ''}
            def command(*args: str) -> str:
                commands.append(args)
                return 'ImageManifestError fixture\n' if args[0] == 'journalctl' else ''
            with patch.object(manage, 'BASE', root), \
                 patch.object(manage, 'UNIT', root / 'runner.service'), \
                 patch.object(manage, 'PIN', root / 'pin.target'), \
                 patch.object(manage, 'FENCE', fence), \
                 patch.object(manage, 'RUNTIME', runtime), \
                 patch.object(manage.artifact, 'verify'), \
                 patch.object(manage.launcher, 'show', return_value=state), \
                 patch.object(manage, 'wait', return_value={'Result': 'exit-code'}), \
                 patch.object(manage, 'command', side_effect=command), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(manage.launcher.Refused, 'CONTROL_LIMIT'):
                    manage.batch(1, '')
                self.assertEqual(len(list(requests.iterdir())), 1001)
                self.assertFalse(commands)
                # Explicit fixture-only recovery after preserving a checksum snapshot.
                # No application cleanup ever iterates or deletes these old requests.
                snapshot = {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                            for path in requests.glob('*/*')}
                self.assertEqual(len(snapshot), 3003)
                quarantine = root / 'reviewed-quarantine'
                quarantine.mkdir()
                for index, path in enumerate(empty):
                    for child in path.iterdir():
                        self.assertEqual(child.read_bytes(), b'{}\n')
                    path.rename(quarantine / path.name)
                    if index == 0:  # Exactly 1000 also reserves capacity for apply.
                        with self.assertRaisesRegex(manage.launcher.Refused, 'CONTROL_LIMIT'):
                            manage.batch(1, '')
                # Repeating the reviewed recovery cannot overwrite or remove data.
                for path in empty:
                    self.assertFalse(path.exists())
                    for item in ('request.json', 'inventory.jsonl', 'approval.json'):
                        saved = quarantine / path.name / item
                        self.assertEqual(hashlib.sha256(saved.read_bytes()).hexdigest(),
                                         snapshot[str(path / item)])
                for _ in range(8):
                    with self.assertRaisesRegex(manage.launcher.Refused, 'PREPARATION_FAILED'):
                        manage.batch(1, '')
                self.assertEqual(len(list(requests.iterdir())), 19)
                self.assertEqual(list(runtime.iterdir()), [])
                evidence = list((root / 'preparations').iterdir())
                self.assertEqual(len(evidence), 8)
                for folder in evidence:
                    checksums = json.loads((folder / 'sha256.json').read_text())
                    for item, digest in checksums.items():
                        self.assertEqual(manage.artifact.sha(folder / item), digest)
                # A later successful discovery works after recovery and failures.
                with patch.object(manage, 'wait', return_value={'Result': 'success'}), \
                     patch.object(manage, 'command', side_effect=lambda *args:
                         'IMAGE_PREPARE=' + json.dumps({'next': '', 'scanned': 1, 'batch': None})
                         if args[0] == 'journalctl' else ''):
                    manage.batch(1, '')
                self.assertEqual(json.loads((root / 'cursor.json').read_text()), '')
                self.assertEqual(filled, {str(path): path.read_bytes() for path in requests.glob('*/*')})
                self.assertEqual(locks.read_bytes(), b'unknown owner')
                self.assertEqual((fence.stat().st_ino, fence.read_bytes()),
                                 (before.st_ino, b'fence inode must survive'))
                self.assertFalse(any('clean' in call or 'release' in call for call in commands))
                self.assertTrue(all(len(call) == 3 and call[2].startswith('shop-image-prepare-')
                                    for call in commands if 'reset-failed' in call))
                fd = manage.launcher.acquire_fence(fence)
                manage.os.close(fd)

    def test_unproven_cleanup_retains_unit(self) -> None:
        import manage
        with tempfile.TemporaryDirectory(prefix='image-retain-test-') as name:
            root = Path(name).resolve()
            path = root / 'shop-image-prepare-fixture.service'
            path.write_bytes(b'unit')
            with patch.object(manage, 'command') as command, \
                 patch.object(manage.launcher, 'show', return_value={'ActiveState': 'active'}):
                with self.assertRaisesRegex(manage.launcher.Refused, 'PREP_NOT_QUIESCENT'):
                    manage.finish_preparation(path, b'unit', root / 'evidence')
                self.assertEqual(path.read_bytes(), b'unit')
                self.assertEqual(command.call_args_list, [call(
                    'systemctl', 'stop', path.name)])

    def test_prepare_has_no_apply_mounts_or_fdstore(self) -> None:
        import manage
        template = (Path(__file__).resolve().parents[1] / 'shop-image-runner@.service').read_text()
        body = manage.preparation_body(template, 'fixture', 1, '', None)
        self.assertNotIn(':/input/', body)
        self.assertNotIn(':/run/image-manager.sock', body)
        self.assertIn('FileDescriptorStoreMax=0', body)
        self.assertIn('FileDescriptorStorePreserve=no', body)

    def test_changed_unit_or_missing_evidence_never_resets_or_unlinks(self) -> None:
        import manage
        for failure in ('changed', 'journal', 'write', 'fdstore'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='image-evidence-test-') as name:
                root = Path(name).resolve()
                path = root / 'shop-image-prepare-fixture.service'
                path.write_bytes(b'changed' if failure == 'changed' else b'unit')
                state = {'LoadState': 'loaded', 'ActiveState': 'failed', 'MainPID': '0',
                         'NRestarts': '0', 'NFileDescriptorStore': '1' if failure == 'fdstore' else '0',
                         'ControlGroup': ''}
                def command(*args: str) -> str:
                    if failure == 'journal' and args[0] == 'journalctl':
                        raise OSError('evidence unavailable')
                    return ''
                with patch.object(manage.launcher, 'show', return_value=state), \
                     patch.object(manage, 'command', side_effect=command) as calls, \
                     patch.object(manage, 'private', side_effect=OSError('evidence write failed')):
                    with self.assertRaises((manage.launcher.Refused, OSError)):
                        manage.finish_preparation(path, b'unit', root / 'preparations/fixture')
                    self.assertTrue(path.is_file())
                    self.assertFalse(any('reset-failed' in item.args or 'clean' in item.args
                                         for item in calls.call_args_list))
