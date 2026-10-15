"""Portable parser/contract regressions, NOT evidence of Linux enforcement."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import launcher as runner


INSTANCE = "550e8400-e29b-41d4-a716-446655440001"


def approved() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "kind": "image-sandbox-inspection",
        "runId": INSTANCE,
        "batchSize": 1,
        **{
            key: "a" * 64
            for key in (
                "inventorySha256",
                "approvalSha256",
                "launcherSha256",
                "unitSha256",
                "pinSha256",
            )
        },
    }


def mount_fixture() -> list[runner.Mount]:
    lines = [
        "1 0 8:1 /rootfs / ro - ext4 /dev/fake ro",
        "2 1 8:1 /uploads /storage rw - ext4 /dev/fake rw",
        "3 2 8:1 /uploads/products /storage/products ro - ext4 /dev/fake rw",
        "4 1 8:1 /request /input/request.json ro - ext4 /dev/fake rw",
        "5 1 8:1 /inventory /input/inventory.jsonl ro - ext4 /dev/fake rw",
        "6 1 8:1 /approval /input/approval.json ro - ext4 /dev/fake rw",
        "7 1 0:1 / /sys/fs/cgroup ro - cgroup2 cgroup ro",
        "8 1 0:2 / /tmp rw - tmpfs tmpfs rw,size=65536k",
        "9 1 0:3 / /run rw - tmpfs tmpfs rw,size=8192k",
    ]
    return runner.mounts("\n".join(lines))


def limits() -> dict[str, str]:
    return {
        "memory.max": str(runner.MAX_MEMORY),
        "memory.high": str(runner.HIGH_MEMORY),
        "memory.swap.max": "0",
        "memory.oom.group": "1",
        "pids.max": "64",
        "cgroup.type": "domain",
        "cpu.max": "50000 100000",
    }


class ParserTests(unittest.TestCase):
    def test_strict_request(self) -> None:
        self.assertEqual(runner.request(json.dumps(approved()), INSTANCE), approved())

    def test_no_scope_expansion_or_apply_switch(self) -> None:
        for key, value in (
            ("apply", True),
            ("debug", True),
            ("command", "other"),
            ("sourceRoot", "/other"),
            ("concurrency", 2),
            ("force", True),
        ):
            with self.subTest(key=key), self.assertRaises(runner.Refused):
                runner.request(json.dumps({**approved(), key: value}), INSTANCE)

    def test_invalid_batches(self) -> None:
        for value in (True, 0, 2, 51, "1", 100000):
            with self.subTest(value=value), self.assertRaises(runner.Refused):
                runner.request(json.dumps({**approved(), "batchSize": value}), INSTANCE)

    def test_explicit_batches(self) -> None:
        for value in (1, 5, 20, 50):
            self.assertEqual(
                runner.request(
                    json.dumps({**approved(), "batchSize": value}), INSTANCE
                )["batchSize"],
                value,
            )

    def test_digest_and_instance(self) -> None:
        for value in ("", "A" * 64, "a" * 63, "../inventory"):
            with self.subTest(value=value), self.assertRaises(runner.Refused):
                runner.request(
                    json.dumps({**approved(), "inventorySha256": value}), INSTANCE
                )
        with self.assertRaises(runner.Refused):
            runner.request(json.dumps(approved()), "other")

    def test_approval_must_name_the_exact_instance_and_batch(self) -> None:
        value = {"runId": INSTANCE, "batchSize": 1}
        runner.approval_scope(json.dumps(value), approved())
        for change in (
            {"runId": "550e8400-e29b-41d4-a716-446655440002"},
            {"batchSize": 5},
            {"batchSize": True},
        ):
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(runner.Refused, "SCOPE_MISMATCH"),
            ):
                runner.approval_scope(json.dumps({**value, **change}), approved())

    def test_duplicate_json(self) -> None:
        with self.assertRaises(runner.Refused):
            runner.strict_json('{"kind":"x","kind":"y"}')
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant), self.assertRaises(runner.Refused):
                runner.strict_json('{"value":' + constant + "}")

    def test_cgroup_exact_limits_parser(self) -> None:
        self.assertEqual(runner.cgroup_policy(limits()), limits())

    def test_missing_unlimited_or_weaker_limits(self) -> None:
        for key in limits():
            for value in ("max", "", "999999999999"):
                with (
                    self.subTest(key=key, value=value),
                    self.assertRaises(runner.Refused),
                ):
                    runner.cgroup_policy({**limits(), key: value})

    def test_cpu_quota_parser(self) -> None:
        for value in ("max 100000", "50001 100000", "50000 0", "-1 100000", "0 100000"):
            with self.subTest(value=value), self.assertRaises(runner.Refused):
                runner.cgroup_policy({**limits(), "cpu.max": value})

    def test_cgroup_path(self) -> None:
        self.assertEqual(
            runner.cgroup_path("0::/system.slice/test.service\n"),
            "/system.slice/test.service",
        )
        for value in (
            "0::/",
            "0::/../../etc",
            "2:memory:/test",
            "0::/test\n1:cpu:/test",
        ):
            with self.subTest(value=value), self.assertRaises(runner.Refused):
                runner.cgroup_path(value)

    def test_mount_parser_accepts_closed_fixture(self) -> None:
        self.assertEqual(runner.mount_policy(mount_fixture())["writableMount"], 2)

    def test_writable_original_or_input(self) -> None:
        for index in (2, 3, 4, 5):
            items = mount_fixture()
            item = items[index]
            items[index] = runner.Mount(
                item.id,
                item.device,
                item.root,
                item.path,
                frozenset({"rw"}),
                item.kind,
                item.super_options,
            )
            with self.subTest(index=index), self.assertRaises(runner.Refused):
                runner.mount_policy(items)

    def test_writable_alias(self) -> None:
        for path in ("/alias", "/storage/products/alias", "/proc/host-root"):
            items = mount_fixture() + [
                runner.Mount(
                    10,
                    "8:1",
                    "/uploads/products",
                    path,
                    frozenset({"rw"}),
                    "ext4",
                    frozenset({"rw"}),
                )
            ]
            with self.subTest(path=path), self.assertRaises(runner.Refused):
                runner.mount_policy(items)

    def test_foreign_proc_alias_and_writable_sysfs(self) -> None:
        for path, kind, options in (
            ("/host-proc", "proc", {"ro"}),
            ("/proc/host", "proc", {"ro"}),
            ("/sys", "sysfs", {"rw"}),
        ):
            items = mount_fixture() + [
                runner.Mount(
                    10, "0:9", "/", path, frozenset(options), kind, frozenset(options)
                )
            ]
            with self.subTest(path=path), self.assertRaises(runner.Refused):
                runner.mount_policy(items)

    def test_separate_bind_mount_is_not_same_device_proof(self) -> None:
        items = mount_fixture() + [
            runner.Mount(
                10,
                "8:1",
                "/uploads/product-variants",
                "/storage/product-variants",
                frozenset({"rw"}),
                "ext4",
                frozenset({"rw"}),
            )
        ]
        with self.assertRaisesRegex(runner.Refused, "LINK_MOUNT_MISMATCH"):
            runner.mount_policy(items)

    def test_stacked_mounts(self) -> None:
        with self.assertRaisesRegex(runner.Refused, "STACKED_MOUNT"):
            runner.mounts("1 0 8:1 / / rw - ext4 /x rw\n2 1 8:1 / / ro - ext4 /x ro")

    def test_mount_escapes(self) -> None:
        item = runner.mounts(r"1 0 8:1 /a\040b /a\040b ro - ext4 /x ro")[0]
        self.assertEqual(item.path, "/a b")

    def test_unbounded_temp(self) -> None:
        items = mount_fixture()
        item = items[-2]
        for options in (frozenset({"rw"}), frozenset({"rw", "size=1g"})):
            items[-2] = runner.Mount(
                item.id,
                item.device,
                item.root,
                item.path,
                item.options,
                item.kind,
                options,
            )
            with self.subTest(options=options), self.assertRaises(runner.Refused):
                runner.mount_policy(items)

    def test_manager_is_required(self) -> None:
        with self.assertRaisesRegex(runner.Refused, "MANAGER_POLICY_UNVERIFIED"):
            runner.manager_policy({}, {}, "test.service", "/test")

    def test_manager_parser_requires_pin_and_no_effective_overrides(self) -> None:
        values = {
            "LoadState": "loaded",
            "Type": "exec",
            "Restart": "no",
            "Delegate": "no",
            "KillMode": "control-group",
            "OOMPolicy": "kill",
            "SendSIGKILL": "yes",
            "RuntimeMaxUSec": "10min",
            "TimeoutStopUSec": "30s",
            "ControlGroup": "/test",
            "PrivatePIDs": "yes",
            "PrivateMounts": "yes",
            "NoNewPrivileges": "yes",
            "FileDescriptorStoreMax": "1",
            "FileDescriptorStorePreserve": "yes",
            "NotifyAccess": "main",
            "DropInPaths": "",
            "NeedDaemonReload": "no",
            "Transient": "no",
            "FragmentPath": "/etc/systemd/system/shop-image-runner@.service",
        }
        pin = {
            "ActiveState": "active",
            "RefuseManualStop": "yes",
            "DropInPaths": "",
            "NeedDaemonReload": "no",
            "FragmentPath": "/etc/systemd/system/shop-image-runner-pin@.target",
            "Wants": "test.service",
        }
        runner.manager_policy(values, pin, "test.service", "/test")
        for change in (
            {"Restart": "always"},
            {"PrivatePIDs": "no"},
            {"ControlGroup": "/other"},
            {"RuntimeMaxUSec": "infinity"},
            {"DropInPaths": "/override.conf"},
        ):
            with self.subTest(change=change), self.assertRaises(runner.Refused):
                runner.manager_policy(
                    {**values, **change}, pin, "test.service", "/test"
                )
        with self.assertRaisesRegex(runner.Refused, "FENCE_PIN_UNVERIFIED"):
            runner.manager_policy(
                values, {**pin, "ActiveState": "inactive"}, "test.service", "/test"
            )

    def test_environment_is_an_allowlist_not_an_attestation(self) -> None:
        runner.environment_policy({"PATH", "LANG", "NOTIFY_SOCKET", "INVOCATION_ID"})
        for name in (
            "DATABASE_URL",
            "TELEGRAM_BOT_TOKEN",
            "ADMIN_PASSWORD",
            "OTHER_SECRET",
            "IMAGE_SANDBOX_VERIFIED",
            "NODE_OPTIONS",
            "LD_PRELOAD",
            "PYTHONPATH",
        ):
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(runner.Refused, "SECRET_ENV_REFUSED"),
            ):
                runner.environment_policy({"PATH", name})

    def test_process_caps_and_no_new_privileges_parser(self) -> None:
        valid = "NoNewPrivs: 1\nCapEff: e4\nCapAmb: 0\nSeccomp: 2\n"
        runner.process_policy(valid)
        for value in (
            valid.replace("NoNewPrivs: 1", "NoNewPrivs: 0"),
            valid.replace("CapEff: e4", "CapEff: ffffffffff"),
            valid.replace("CapAmb: 0", "CapAmb: 1"),
            valid.replace("Seccomp: 2", "Seccomp: 0"),
        ):
            with self.subTest(value=value), self.assertRaises(runner.Refused):
                runner.process_policy(value)

    def test_launcher_refuses_on_windows_and_never_has_apply_mode(self) -> None:
        for extra in (("--apply",), ("--force",), (INSTANCE, "--apply")):
            child = subprocess.run(
                [sys.executable, "-I", str(Path(runner.__file__)), *extra],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(child.returncode, 78)
            self.assertEqual(json.loads(child.stdout)["error"], "SANDBOX_UNVERIFIED")


class LockDiagnosticsTests(unittest.TestCase):
    def test_unknown_lock_retained(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-policy-") as name:
            root = Path(name).resolve()
            lock = root / "locks" / "unknown.lock"
            lock.parent.mkdir()
            lock.write_bytes(b'{"pid":99999999,"age":"old"}')
            before = lock.stat()
            content = lock.read_bytes()
            with self.assertRaisesRegex(runner.Refused, "BUSY"):
                runner.unknown_locks(root)
            self.assertEqual(lock.read_bytes(), content)
            self.assertEqual(lock.stat().st_ino, before.st_ino)
            self.assertEqual(lock.stat().st_mtime_ns, before.st_mtime_ns)

    def test_unknown_run_lock_retained(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-policy-") as name:
            root = Path(name).resolve()
            lock = root / "production-runs" / INSTANCE / "run.lock"
            lock.parent.mkdir(parents=True)
            lock.write_bytes(b"")
            with self.assertRaisesRegex(runner.Refused, "BUSY"):
                runner.unknown_locks(root)
            self.assertTrue(lock.exists())

    def test_scan_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="korzina-image-policy-") as name:
            root = Path(name).resolve()
            (root / "runs").mkdir()
            for index in range(3):
                (root / "runs" / str(index)).mkdir()
            with self.assertRaisesRegex(runner.Refused, "LOCK_SCAN_LIMIT"):
                runner.unknown_locks(root, limit=2)


class UnitContractTests(unittest.TestCase):
    def test_units_are_manual_and_bounded(self) -> None:
        deploy = Path(__file__).resolve().parents[1]
        service = (deploy / "shop-image-runner@.service").read_text(encoding="utf-8")
        pin = (deploy / "shop-image-runner-pin@.target").read_text(encoding="utf-8")
        for literal in (
            "Type=exec",
            "Restart=no",
            "KillMode=control-group",
            "MemoryMax=768M",
            "MemoryHigh=512M",
            "MemorySwapMax=0",
            "TasksMax=64",
            "CPUQuota=50%",
            "OOMPolicy=kill",
            "RuntimeMaxSec=600",
            "PrivatePIDs=yes",
            "RootDirectory=",
            "FileDescriptorStorePreserve=yes",
        ):
            self.assertIn(literal, service)
        self.assertNotIn("\n[Install]", service + pin)
        self.assertNotIn("EnvironmentFile=", service)
        self.assertNotIn("--apply", service)
        self.assertIn("RefuseManualStop=yes", pin)

    def test_production_gate_unchanged(self) -> None:
        root = Path(__file__).resolve().parents[2]
        gate = (
            root / "apps/api/data/product-image-production/environment.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("export function requireProductionSandbox(): never", gate)
        self.assertIn("throw new RunnerError('SANDBOX_UNVERIFIED')", gate)
        self.assertNotIn("process.env", gate)


if __name__ == "__main__":
    unittest.main()
