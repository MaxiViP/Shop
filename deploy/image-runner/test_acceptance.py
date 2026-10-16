"""Portable regressions for fail-closed acceptance selection and fixture rendering."""

from pathlib import Path
import unittest

import launcher as runner
import preflight
from test_namespace import render


class AcceptancePolicyTests(unittest.TestCase):
    def test_host_stacked_boot_mounts_do_not_relax_runner_namespace(self) -> None:
        mounts = (
            "1 0 8:1 / / rw - ext4 /disk rw\n"
            "2 1 0:1 / /run rw - tmpfs tmpfs rw\n"
            "3 1 0:2 / /run rw - tmpfs tmpfs rw\n"
            "4 1 0:3 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n"
        )
        preflight.host_cgroup_mount(mounts)
        with self.assertRaisesRegex(runner.Refused, "STACKED_MOUNT"):
            runner.mounts(mounts)
        for invalid in (mounts.replace("cgroup2", "cgroup"), mounts.split("4 1")[0]):
            with self.subTest(invalid=invalid), self.assertRaises(runner.Refused):
                preflight.host_cgroup_mount(invalid)

    def test_preflight_rejects_missing_kernel_manager_features(self) -> None:
        preflight.policy("systemd", 258, {"memory", "cpu", "pids"}, 1)
        for pid, version, controllers, namespaces in (
            ("python", 258, {"memory", "cpu", "pids"}, 1),
            ("systemd", 255, {"memory", "cpu", "pids"}, 1),
            ("systemd", 257, {"memory", "cpu", "pids"}, 1),
            ("systemd", 258, {"cpu", "pids"}, 1),
            ("systemd", 258, {"memory", "cpu", "pids"}, 0),
        ):
            with (
                self.subTest(
                    pid=pid,
                    version=version,
                    controllers=controllers,
                    namespaces=namespaces,
                ),
                self.assertRaises(runner.Refused),
            ):
                preflight.policy(pid, version, controllers, namespaces)

    def test_render_uses_only_new_fixture_roots_and_units(self) -> None:
        template = (
            Path(__file__).resolve().parents[1] / "shop-image-runner@.service"
        ).read_text()
        for mode in ("positive", "exdev", "alias"):
            body = render(
                template,
                Path("/tmp/image-namespace-fixture-abc"),
                Path("/run/systemd/system/image-fixture-abc.service"),
                Path("/run/systemd/system/image-fixture-abc.target"),
                mode,
            )
            self.assertNotIn("korzinamarket", body.lower())
            self.assertNotIn("%i", body)
            self.assertNotIn("--apply", body)
            self.assertIn("Restart=no", body)
            self.assertIn("PrivatePIDs=yes", body)
            self.assertIn("PrivateUsers=full", body)
            self.assertIn("InaccessiblePaths=+/proc/sys/fs/binfmt_misc", body)
