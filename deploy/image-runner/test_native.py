"""Native Linux primitives. No mocked statfs, locks, fsync or mount IDs."""

import array
import errno
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

import launcher as runner


@unittest.skipUnless(sys.platform == "linux", "NOT VERIFIED: requires native Linux")
class NativeTests(unittest.TestCase):
    def test_exclusive_fsync_link_no_clobber_and_directory_fsync(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-native-") as name:
            folder = Path(name).resolve()
            original, staged, output = (
                folder / "original",
                folder / "staged",
                folder / "output",
            )
            original.write_bytes(b"original fixture bytes")
            baseline = original.stat()
            source_hash = hashlib.sha256(original.read_bytes()).hexdigest()
            fd = os.open(
                staged, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600
            )
            try:
                os.write(fd, b"derived fixture bytes")
                os.fsync(fd)
            finally:
                os.close(fd)
            with self.assertRaises(FileExistsError):
                os.open(
                    staged, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600
                )
            os.link(staged, output)
            self.assertEqual(staged.stat().st_ino, output.stat().st_ino)
            self.assertNotEqual(original.stat().st_ino, output.stat().st_ino)
            self.assertEqual(output.read_bytes(), b"derived fixture bytes")
            before = output.stat()
            with self.assertRaises(FileExistsError):
                os.link(staged, output)
            self.assertEqual(output.stat().st_ino, before.st_ino)
            self.assertEqual(output.stat().st_mtime_ns, before.st_mtime_ns)
            directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            self.assertEqual(original.stat().st_ino, baseline.st_ino)
            self.assertEqual(original.stat().st_mtime_ns, baseline.st_mtime_ns)
            self.assertEqual(
                hashlib.sha256(original.read_bytes()).hexdigest(), source_hash
            )
            self.assertGreater(os.statvfs(folder).f_bavail, 0)

    def test_native_no_follow(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-native-") as name:
            root = Path(name).resolve()
            (root / "file").write_bytes(b"fixture")
            (root / "alias").symlink_to(root / "file")
            with self.assertRaises(OSError) as error:
                os.open(root / "alias", os.O_RDONLY | os.O_NOFOLLOW)
            self.assertEqual(error.exception.errno, errno.ELOOP)

    def test_unknown_symlink_lock_is_retained(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-native-") as name:
            root = Path(name).resolve()
            original = root / "original"
            original.write_bytes(b"fixture original")
            (root / "locks").mkdir()
            lock = root / "locks" / "unknown.lock"
            lock.symlink_to(original)
            before = lock.lstat()
            with self.assertRaisesRegex(runner.Refused, "UNSAFE_PATH"):
                runner.unknown_locks(root)
            self.assertEqual(lock.lstat().st_ino, before.st_ino)
            self.assertTrue(lock.is_symlink())
            self.assertEqual(original.read_bytes(), b"fixture original")

    def test_native_metadata_digest_no_clobber_and_permissions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-native-") as name:
            path = Path(name).resolve() / "input"
            path.write_bytes(b"fixture inventory\n")
            path.chmod(0o600)
            runner.digest(path, 4096, hashlib.sha256(path.read_bytes()).hexdigest())
            with self.assertRaisesRegex(runner.Refused, "DIGEST_MISMATCH"):
                runner.digest(path, 4096, "0" * 64)
            os.link(path, path.with_suffix(".alias"))
            with self.assertRaisesRegex(runner.Refused, "UNSAFE_FILE"):
                runner.digest(path, 4096, "0" * 64)

    @unittest.skipUnless(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        "NOT VERIFIED: root-owned deploy fence fixture",
    )
    def test_native_flock_readonly_and_missing_symlink_refusal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-fence-") as name:
            root = Path(name).resolve()
            path = root / "deploy.lock"
            path.write_bytes(b"do not truncate")
            path.chmod(0o600)
            before = path.stat()
            fd = runner.acquire_fence(path)
            try:
                with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                    runner.acquire_fence(path)
                self.assertEqual(path.read_bytes(), b"do not truncate")
                self.assertEqual(path.stat().st_ino, before.st_ino)
                (root / "alias").symlink_to(path)
                with self.assertRaisesRegex(runner.Refused, "UNSAFE_PATH"):
                    runner.acquire_fence(root / "alias")
                with self.assertRaises(FileNotFoundError):
                    runner.acquire_fence(root / "missing")
                self.assertFalse((root / "missing").exists())
            finally:
                os.close(fd)
            next_fd = runner.acquire_fence(path)
            os.close(next_fd)

    @unittest.skipUnless(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        "NOT VERIFIED: root-owned deploy fence fixture",
    )
    def test_deploy_style_truncating_fd9_cannot_cross_fence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-fence-") as name:
            path = Path(name).resolve() / "deploy.lock"
            path.write_bytes(b"")
            path.chmod(0o600)
            before = path.stat()
            fd = runner.acquire_fence(path)
            code = (
                "import fcntl,os,sys; "
                "fd=os.open(sys.argv[1],os.O_WRONLY|os.O_TRUNC); "
                "os.dup2(fd,9); fcntl.flock(9,fcntl.LOCK_EX|fcntl.LOCK_NB)"
            )
            try:
                blocked = subprocess.run(
                    [sys.executable, "-c", code, str(path)],
                    capture_output=True,
                    timeout=5,
                    check=False,
                )
                self.assertNotEqual(blocked.returncode, 0)
                self.assertIn(b"BlockingIOError", blocked.stderr)
                self.assertEqual(path.stat().st_ino, before.st_ino)
            finally:
                os.close(fd)
            permitted = subprocess.run(
                [sys.executable, "-c", code, str(path)],
                capture_output=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(permitted.returncode, 0, permitted.stderr)

    @unittest.skipUnless(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        "NOT VERIFIED: root-owned deploy fence fixture",
    )
    def test_scm_rights_duplicate_survives_owner_sigkill_and_unrelated_child(
        self,
    ) -> None:
        # This proves the kernel FD-dup primitive, NOT systemd FDSTORE acceptance.
        with tempfile.TemporaryDirectory(prefix="korzina-image-fence-") as name:
            root = Path(name).resolve()
            lock = root / "deploy.lock"
            lock.write_bytes(b"fixture fence")
            lock.chmod(0o600)
            address = str(root / "fd.socket")
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as keeper:
                keeper.bind(address)
                keeper.settimeout(5)
                owner = subprocess.Popen(
                    [
                        sys.executable,
                        "-B",
                        str(Path(__file__).with_name("payload.py")),
                        "fd-owner",
                        address,
                        str(lock),
                    ],
                    close_fds=True,
                )
                worker = subprocess.Popen(
                    [sys.executable, "-c", "import time; time.sleep(20)"],
                    close_fds=True,
                )
                stored = -1
                try:
                    message, ancillary, _, _ = keeper.recvmsg(
                        64, socket.CMSG_SPACE(array.array("i").itemsize)
                    )
                    self.assertEqual(message, b"owned")
                    descriptors = array.array("i")
                    descriptors.frombytes(ancillary[0][2][: array.array("i").itemsize])
                    stored = descriptors[0]
                    owner.kill()
                    owner.wait(timeout=5)
                    self.assertIsNone(worker.poll())
                    with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                        runner.acquire_fence(lock)
                    worker.kill()
                    worker.wait(timeout=5)
                    with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                        runner.acquire_fence(lock)
                    os.close(stored)
                    stored = -1
                    fd = runner.acquire_fence(lock)
                    os.close(fd)
                finally:
                    if stored >= 0:
                        os.close(stored)
                    for child in (owner, worker):
                        if child.poll() is None:
                            child.kill()
                        child.wait(timeout=5)

    def test_native_bind_mount_exdev_same_device(self) -> None:
        one, two = Path("/fixture-mounts/one"), Path("/fixture-mounts/two")
        if not one.is_dir() or not two.is_dir():
            self.skipTest("NOT VERIFIED: two disposable bind mounts were not provided")
        items = runner.mounts(runner.text(Path("/proc/self/mountinfo"), 1024 * 1024))
        self.assertNotEqual(
            runner.mount_at(items, str(one)).id, runner.mount_at(items, str(two)).id
        )
        with tempfile.TemporaryDirectory(prefix="korzina-image-bind-", dir=one) as name:
            folder = Path(name)
            first = folder / "staged"
            second = two / folder.name / "output"
            first.write_bytes(b"native EXDEV fixture")
            self.assertEqual(first.stat().st_dev, second.parent.stat().st_dev)
            with self.assertRaises(OSError) as error:
                os.link(first, second)
            self.assertEqual(error.exception.errno, errno.EXDEV)
            self.assertFalse(second.exists())
            self.assertEqual(first.read_bytes(), b"native EXDEV fixture")

    def test_native_readonly_original_and_inventory_mounts(self) -> None:
        one, readonly = Path("/fixture-mounts/one"), Path("/fixture-mounts/readonly")
        if not one.is_dir() or not readonly.is_dir():
            self.skipTest(
                "NOT VERIFIED: disposable readonly bind mount was not provided"
            )
        with tempfile.TemporaryDirectory(prefix="korzina-image-ro-", dir=one) as name:
            folder = Path(name)
            original = folder / "original"
            original.write_bytes(b"original fixture and inventory bytes")
            original.chmod(0o600)
            path = readonly / folder.name / "original"
            before = original.stat()
            for mutate in (
                lambda: os.open(path, os.O_WRONLY | os.O_TRUNC),
                lambda: path.unlink(),
                lambda: path.rename(path.with_suffix(".renamed")),
                lambda: path.chmod(0o777),
                lambda: os.link(path, folder / "alias"),
            ):
                with self.subTest(mutate=mutate), self.assertRaises(OSError) as error:
                    mutate()
                self.assertIn(error.exception.errno, (errno.EROFS, errno.EXDEV))
            self.assertEqual(
                original.read_bytes(), b"original fixture and inventory bytes"
            )
            self.assertEqual(original.stat().st_ino, before.st_ino)
            self.assertEqual(original.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertEqual(original.stat().st_nlink, 1)
            self.assertEqual(
                (
                    original.stat().st_uid,
                    original.stat().st_gid,
                    original.stat().st_mode,
                ),
                (before.st_uid, before.st_gid, before.st_mode),
            )


if __name__ == "__main__":
    unittest.main()
