"""Opt-in lifecycle acceptance on a disposable systemd v257+ VM only.

Never installs/starts the production template. All units and data are newly created
korzina-image-sandbox-fixture-* objects. A container without systemd reports skips.
This tests lifecycle/FDSTORE primitives, not the unprovisioned production rootfs.
"""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import launcher as runner


def systemd_available() -> bool:
    if sys.platform != "linux" or os.geteuid() != 0:
        return False
    if Path("/proc/1/comm").read_text().strip() != "systemd":
        return False
    if os.environ.get("KORZINA_DISPOSABLE_SYSTEMD") != "1":
        return False  # Operator opt-in only; never accepted as proof of containment.
    version = subprocess.run(
        ["systemctl", "--version"],
        capture_output=True,
        text=True,
        timeout=3,
        check=False,
    )
    return version.returncode == 0 and int(version.stdout.split()[1]) >= 257


@unittest.skipUnless(
    systemd_available(), "NOT VERIFIED: disposable root/systemd v257+ VM required"
)
class SystemdTests(unittest.TestCase):
    def command(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["systemctl", *args],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

    def case(self, mode: str, action: str) -> None:
        name = "korzina-image-sandbox-fixture-" + uuid.uuid4().hex
        service, target = name + ".service", name + ".target"
        unit_root = Path("/run/systemd/system")
        service_path, target_path = unit_root / service, unit_root / target
        # TemporaryDirectory is the only source of data paths. No shop originals or DB.
        with tempfile.TemporaryDirectory(
            prefix="korzina-image-systemd-", delete=False
        ) as temporary:
            root = Path(temporary).resolve()
            self.assertTrue(root.name.startswith("korzina-image-systemd-"))
            root.chmod(0o755)
            data = root / "data"
            data.mkdir(mode=0o700)
            os.chown(data, 65534, 65534)
            fence = data / "deploy.lock"
            fence.write_bytes(b"isolated systemd fixture lock")
            os.chown(fence, 0, 65534)
            fence.chmod(0o640)
            fence_before = fence.stat()
            for file in ("payload.py", "launcher.py"):
                shutil.copyfile(Path(__file__).with_name(file), root / file)
                (root / file).chmod(0o644)
            body = f"""[Unit]
CollectMode=inactive
[Service]
Type=exec
User=65534
Group=65534
ExecStart=/usr/bin/python3 -B {root}/payload.py lifecycle {mode} {data}
Restart=no
RuntimeMaxSec=5
RuntimeRandomizedExtraSec=0
TimeoutStopSec=1
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
FinalKillSignal=SIGKILL
OOMPolicy=kill
MemoryAccounting=yes
MemoryHigh=512M
MemoryMax=768M
MemorySwapMax=0
CPUQuota=50%
TasksMax=64
Delegate=no
NotifyAccess=main
FileDescriptorStoreMax=1
FileDescriptorStorePreserve=yes
PrivatePIDs=yes
PrivateMounts=yes
PrivateNetwork=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
"""
            pin = f"[Unit]\nWants={service}\nAfter={service}\nRefuseManualStop=yes\nIgnoreOnIsolate=yes\n"
            with service_path.open("x") as handle:
                handle.write(body)
            with target_path.open("x") as handle:
                handle.write(pin)
            group: Path | None = None
            quiescent = False
            try:
                self.assertEqual(self.command("daemon-reload").returncode, 0)
                started = self.command("start", target)
                self.assertEqual(started.returncode, 0, started.stderr)
                deadline = time.monotonic() + 4
                while not (data / "ready").exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(
                    (data / "ready").exists(), self.command("status", service).stdout
                )
                values = runner.show(service)
                group = Path("/sys/fs/cgroup") / values["ControlGroup"].lstrip("/")
                self.assertTrue(group.is_dir())
                actual = {
                    key: (group / key).read_text()
                    for key in (
                        "memory.max",
                        "memory.high",
                        "memory.swap.max",
                        "memory.oom.group",
                        "cpu.max",
                        "pids.max",
                        "cgroup.type",
                    )
                }
                runner.cgroup_policy(actual)
                pids = (group / "cgroup.procs").read_text().split()
                if mode not in ("parent-memory", "child-memory"):
                    self.assertGreaterEqual(
                        len(pids), 3, "child/grandchild/setsid must remain contained"
                    )
                self.assertEqual(values["Restart"], "no")
                self.assertEqual(values["KillMode"], "control-group")
                if mode in ("parent-memory", "child-memory"):
                    (data / "start").write_text("start", encoding="ascii")
                if mode == "fdstore":
                    self.assertEqual(values["NFileDescriptorStore"], "1")
                    with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                        runner.acquire_fence(fence)
                    self.assertNotEqual(self.command("stop", target).returncode, 0)
                if action == "stop":
                    self.assertEqual(self.command("stop", service).returncode, 0)
                elif action == "kill":
                    # pidfd prevents signalling a reused host PID.
                    pidfd = os.pidfd_open(int(values["MainPID"]))
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                    finally:
                        os.close(pidfd)
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    current = runner.show(service)
                    if current["ActiveState"] in ("failed", "inactive") and (
                        not group.exists()
                        or "populated 0" in (group / "cgroup.events").read_text()
                    ):
                        quiescent = True
                        break
                    time.sleep(0.05)
                self.assertTrue(
                    quiescent, "cgroup still populated; do not release the fence"
                )
                if mode in ("parent-memory", "child-memory"):
                    self.assertEqual(current["Result"], "oom-kill")
                if action == "timeout":
                    self.assertEqual(current["Result"], "timeout")
                time.sleep(0.2)
                self.assertEqual(runner.show(service)["NRestarts"], "0")
                self.assertEqual(runner.show(service)["MainPID"], "0")
                if mode == "fdstore":
                    with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                        runner.acquire_fence(fence)
                    self.assertEqual(runner.show(target)["ActiveState"], "active")
                self.assertEqual(fence.stat().st_ino, fence_before.st_ino)
                self.assertEqual(fence.read_bytes(), b"isolated systemd fixture lock")
            finally:
                # Only known fixture objects, after actual cgroup quiescence. No stale/PID heuristics.
                if quiescent:
                    current_fence = fence.lstat()
                    self.assertEqual(
                        (
                            current_fence.st_dev,
                            current_fence.st_ino,
                            current_fence.st_nlink,
                        ),
                        (fence_before.st_dev, fence_before.st_ino, 1),
                    )
                    self.assertEqual(
                        fence.read_bytes(), b"isolated systemd fixture lock"
                    )
                    self.assertEqual(
                        self.command("clean", "--what=fdstore", service).returncode, 0
                    )
                    target_path.write_text(
                        pin.replace("RefuseManualStop=yes", "RefuseManualStop=no")
                    )
                    self.command("daemon-reload")
                    self.command("stop", target)
                    self.command("reset-failed", service)
                    service_path.unlink()
                    target_path.unlink()
                    self.command("daemon-reload")
                    self.assertEqual(root.parent, Path(tempfile.gettempdir()).resolve())
                    self.assertTrue(root.name.startswith("korzina-image-systemd-"))
                    shutil.rmtree(root)
                else:
                    self.fail(
                        "NOT VERIFIED: retained fixture unit/fence requires disposable VM teardown"
                    )

    def test_sigterm_ignoring_children_and_grandchildren(self) -> None:
        self.case("tree", "stop")

    def test_sigkill_main_and_all_descendants(self) -> None:
        self.case("tree", "kill")

    def test_hung_tree_runtime_limit(self) -> None:
        self.case("tree", "timeout")

    def test_parent_cgroup_oom(self) -> None:
        self.case("parent-memory", "oom")

    def test_child_cgroup_oom(self) -> None:
        self.case("child-memory", "oom")

    def test_fdstore_lifetime_after_sigkill(self) -> None:
        self.case("fdstore", "kill")

    def test_fdstore_lifetime_after_stop(self) -> None:
        self.case("fdstore", "stop")


if __name__ == "__main__":
    if not systemd_available():
        print(
            "NOT VERIFIED: explicit disposable systemd v257+ acceptance is unavailable"
        )
        sys.exit(78)
    unittest.main()
