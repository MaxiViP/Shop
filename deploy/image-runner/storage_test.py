"""Native storage allowlist, using temporary roots only."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import launcher


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Linux root fixture')
class StorageTests(unittest.TestCase):
    def test_telegram_is_opaque_but_not_an_alias(self) -> None:
        with tempfile.TemporaryDirectory(prefix='image-storage-policy-') as name:
            root = Path(name).resolve()
            root.chmod(0o755)
            for item in ('products', 'product-variants', '.product-image-state'):
                (root / item).mkdir(mode=0o700)
            source = root / 'products/550e8400-e29b-41d4-a716-446655440001.webp'
            source.write_bytes(b'fixture')
            telegram = root / 'products/telegram'
            telegram.mkdir(mode=0o755)
            telegram.chmod(0o755)
            media = telegram / 'existing.jpg'
            media.write_bytes(b'existing Telegram bytes')
            before = media.stat()
            with patch.object(launcher, 'STORAGE', root):
                launcher.storage_policy(0, 0)
                self.assertEqual(media.read_bytes(), b'existing Telegram bytes')
                self.assertEqual(media.stat().st_ino, before.st_ino)
                telegram.chmod(0o775)
                with self.assertRaisesRegex(launcher.Refused, 'TELEGRAM_ROOT_UNSAFE'):
                    launcher.storage_policy(0, 0)
                telegram.chmod(0o755)
                os.chown(telegram, 997, 997)
                with self.assertRaisesRegex(launcher.Refused, 'TELEGRAM_ROOT_UNSAFE'):
                    launcher.storage_policy(0, 0)
                os.chown(telegram, 0, 0)
                os.setxattr(telegram, 'user.fixture', b'unverified')
                with self.assertRaisesRegex(launcher.Refused, 'STORAGE_ACL_UNVERIFIED'):
                    launcher.storage_policy(0, 0)
                os.removexattr(telegram, 'user.fixture')
                media.unlink()
                telegram.rmdir()
                telegram.symlink_to(root, target_is_directory=True)
                with self.assertRaisesRegex(launcher.Refused, 'TELEGRAM_ROOT_UNSAFE'):
                    launcher.storage_policy(0, 0)
                telegram.unlink()
                (root / 'products/unknown').mkdir()
                with self.assertRaisesRegex(launcher.Refused, 'SOURCE_ALIAS_UNVERIFIED'):
                    launcher.storage_policy(0, 0)
                (root / 'products/unknown').rmdir()
                alias = root / 'products/550e8400-e29b-41d4-a716-446655440002.webp'
                os.link(source, alias)
                with self.assertRaisesRegex(launcher.Refused, 'SOURCE_ALIAS_UNVERIFIED'):
                    launcher.storage_policy(0, 0)

    def test_nested_source_mount_even_readonly_is_refused(self) -> None:
        for options in ('ro', 'rw'):
            mounts = launcher.mounts(
                '1 0 8:1 / / ro - ext4 /dev/fake ro\n'
                '2 1 8:1 /uploads/products /storage/products ro - ext4 /dev/fake rw\n'
                f'3 2 8:2 / /storage/products/telegram {options} - ext4 /dev/other {options}\n')
            with self.assertRaisesRegex(launcher.Refused, 'SOURCE_NESTED_MOUNT'):
                launcher.source_mount_policy(mounts)
