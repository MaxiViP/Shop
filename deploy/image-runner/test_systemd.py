"""Opt-in lifecycle acceptance on a disposable systemd v258+ VM only.

Never installs/starts the production template. All units and data are newly created
korzina-image-sandbox-fixture-* objects. A container without systemd reports skips.
This tests lifecycle/FDSTORE primitives, not the unprovisioned production rootfs.
"""

import os
import json
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
import preflight


def systemd_available() -> bool:
    return preflight.available()


@unittest.skipUnless(
    systemd_available(), "NOT VERIFIED: disposable root/systemd v258+ VM required"
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
            # memory.high may throttle allocations: OOM needs its own bounded budget.
            runtime = 60 if mode in ("parent-memory", "child-memory") else 12
            body = f"""[Unit]
CollectMode=inactive
[Service]
Type=exec
User=65534
Group=65534
ExecStart=/usr/bin/python3 -B {root}/payload.py lifecycle {mode} {data}
Restart=no
RuntimeMaxSec={runtime}
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
                deadline = time.monotonic() + 10
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
                        len(pids),
                        2 if mode == "orphan" else 3,
                        "child/grandchild/setsid must remain contained",
                    )
                self.assertEqual(values["Restart"], "no")
                self.assertEqual(values["KillMode"], "control-group")
                if mode in ("cpu", "tasks"):
                    self.check_pressure(mode, group, data)
                if mode in ("parent-memory", "child-memory"):
                    (data / "start").write_text("start", encoding="ascii")
                self.assertEqual(values["NFileDescriptorStore"], "1")
                with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                    runner.acquire_fence(fence)
                self.assertNotEqual(self.command("stop", target).returncode, 0)
                # A reload cannot drop the manager's stored open file description.
                self.assertEqual(self.command("daemon-reload").returncode, 0)
                self.assertEqual(runner.show(service)["NFileDescriptorStore"], "1")
                if action == "stop":
                    self.assertEqual(self.command("stop", service).returncode, 0)
                elif action == "kill":
                    # pidfd prevents signalling a reused host PID.
                    pidfd = os.pidfd_open(int(values["MainPID"]))
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                    finally:
                        os.close(pidfd)
                deadline = time.monotonic() + runtime + 8
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
                time.sleep(1)
                self.assertEqual(runner.show(service)["NRestarts"], "0")
                self.assertEqual(runner.show(service)["MainPID"], "0")
                with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                    runner.acquire_fence(fence)
                self.assertEqual(runner.show(target)["ActiveState"], "active")
                if mode == "fdstore":
                    self.assertEqual(self.command("daemon-reexec").returncode, 0)
                    self.assertEqual(runner.show(service)["NFileDescriptorStore"], "1")
                    with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                        runner.acquire_fence(fence)
                if mode == "graceful":
                    self.assertEqual(current["Result"], "success")
                print(
                    "LIFECYCLE_EVIDENCE="
                    + json.dumps(
                        {
                            "mode": mode,
                            "action": action,
                            "limits": actual,
                            "result": current["Result"],
                            "quiescent": quiescent,
                            "fdStore": runner.show(service)["NFileDescriptorStore"],
                            "restarts": runner.show(service)["NRestarts"],
                        },
                        sort_keys=True,
                    ),
                    flush=True,
                )
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
                    # systemd refuses CleanUnit on failed services. Reset only this
                    # known, quiescent fixture, checking pin/store still retain it.
                    self.assertEqual(
                        self.command("reset-failed", service).returncode, 0
                    )
                    self.assertEqual(runner.show(service)["NFileDescriptorStore"], "1")
                    with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                        runner.acquire_fence(fence)
                    cleaned = self.command("clean", "--what=fdstore", service)
                    self.assertEqual(cleaned.returncode, 0, cleaned.stderr)
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

    def test_sigterm_graceful_tree(self) -> None:
        self.case("graceful", "stop")

    def test_sigkill_main_and_all_descendants(self) -> None:
        self.case("tree", "kill")

    def test_double_fork_setsid_orphan_cannot_escape(self) -> None:
        self.case("orphan", "kill")

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

    def check_pressure(self, mode: str, group: Path, data: Path) -> None:
        def counters(file: str) -> dict[str, int]:
            return {
                key: int(value)
                for key, value in (
                    line.split() for line in (group / file).read_text().splitlines()
                )
            }

        if mode == "cpu":
            before = counters("cpu.stat")
            start = time.monotonic()
            (data / "start").write_text("start")
            time.sleep(3)
            elapsed = time.monotonic() - start
            after = counters("cpu.stat")
            self.assertGreater(after["nr_throttled"], before["nr_throttled"])
            # 50% total tree, with a period's burst and scheduler tolerance.
            self.assertLess(
                after["usage_usec"] - before["usage_usec"], elapsed * 750000 + 100000
            )
        else:
            (data / "start").write_text("start")
            deadline = time.monotonic() + 5
            while not (data / "task-limit").exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual((data / "task-limit").read_text(), "EAGAIN")
            self.assertGreater(counters("pids.events")["max"], 0)
            self.assertLessEqual(int((group / "pids.current").read_text()), 64)

    def test_cpu_quota_enforces_whole_tree(self) -> None:
        self.case("cpu", "stop")

    def test_task_limit_refuses_forks(self) -> None:
        self.case("tasks", "stop")


if __name__ == "__main__":
    if not systemd_available():
        print(
            "NOT VERIFIED: explicit disposable systemd v258+ acceptance is unavailable"
        )
        sys.exit(78)
    unittest.main()
