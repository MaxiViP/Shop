"""Native Linux control lifecycle; never touches a host service or image root."""
import contextlib
import io
import json
import stat
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import ANY, patch


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
                 patch.object(manage, 'Path', side_effect=lambda value: runtime if value == '/run/systemd/system' else Path(value)), \
                 patch.object(manage.artifact, 'verify'), \
                 patch.object(manage.launcher, 'regular', side_effect=lambda path, *args, **kwargs: path.lstat()), \
                 patch.object(manage, 'wait', return_value={'Result': 'success'}), \
                 patch.object(manage, 'command', side_effect=command), \
                 contextlib.redirect_stdout(io.StringIO()):
                manage.batch(1, '')
                self.assertEqual(list((root / 'requests').iterdir()), [])
                self.assertEqual(list(runtime.iterdir()), [])
                self.assertEqual(json.loads((root / 'cursor.json').read_text()), '')
