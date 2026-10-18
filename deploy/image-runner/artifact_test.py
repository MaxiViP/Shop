"""Linux-only negative checks for the new artifact verifier, outside old discovery."""

import os
from pathlib import Path
import tempfile
import unittest

import artifact


@unittest.skipUnless(
    os.name == "posix" and os.geteuid() == 0, "Linux build fixture only"
)
class ArtifactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="image-artifact-verifier-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "rootfs"
        self.root.mkdir(mode=0o555)
        self.file = self.root / "runtime"
        self.file.write_bytes(b"enumerated runtime fixture")
        self.file.chmod(0o444)

    def manifest(self) -> dict[str, object]:
        return {
            "productionApply": "requires-launcher-admission",
            "entries": artifact.entries(self.root),
        }

    def test_content_and_unknown_file(self) -> None:
        before = self.manifest()
        artifact.verify(self.root, before)
        self.file.write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "mismatch"):
            artifact.verify(self.root, before)
        (self.root / "unknown").write_bytes(b"unknown")
        (self.root / "unknown").chmod(0o444)
        with self.assertRaisesRegex(ValueError, "mismatch"):
            artifact.verify(self.root, before)

    def test_symlink_target_and_escape(self) -> None:
        (self.root / "alias").symlink_to("runtime")
        before = self.manifest()
        artifact.verify(self.root, before)
        (self.root / "alias").unlink()
        (self.root / "alias").symlink_to("../outside")
        (self.root.parent / "outside").write_bytes(b"outside")
        with self.assertRaisesRegex(ValueError, "escaping symlink"):
            artifact.entries(self.root)

    def test_writable_setuid_and_xattr(self) -> None:
        for mode in (0o666, 0o4644, 0o2644):
            with self.subTest(mode=mode):
                self.file.chmod(mode)
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    artifact.entries(self.root)
        self.file.chmod(0o444)
        os.setxattr(self.file, "user.fixture", b"unknown metadata")
        with self.assertRaisesRegex(ValueError, "unsafe"):
            artifact.entries(self.root)

    def test_gate_marker_required(self) -> None:
        manifest = self.manifest()
        manifest["productionApply"] = "VERIFIED"
        with self.assertRaisesRegex(ValueError, "mismatch"):
            artifact.verify(self.root, manifest)
