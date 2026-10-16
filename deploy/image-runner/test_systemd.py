"""Opt-in lifecycle acceptance on a disposable systemd v258+ VM only.

Never installs/starts the production template. All units and data are newly created
korzina-image-sandbox-fixture-* objects. A container without systemd reports skips.
This tests lifecycle/FDSTORE primitives, not the unprovisioned production rootfs.
"""

import os
import json
from contextlib import ExitStack
from pathlib import Path
import select
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


def counters(group: Path, file: str) -> dict[str, int]:
    return {
        key: int(value)
        for key, value in (
            line.split() for line in (group / file).read_text().splitlines()
        )
    }


def memory_snapshot(group: Path) -> dict[str, object]:
    if not group.is_dir():
        return {"cgroup": "removed", "processes": {}}
    snapshot: dict[str, object] = {}
    for name in (
        "memory.events",
        "memory.events.local",
        "memory.current",
        "memory.peak",
        "memory.high",
        "memory.max",
        "memory.swap.max",
        "memory.oom.group",
        "memory.pressure",
        "memory.stat",
        "cpu.stat",
        "cgroup.events",
        "cgroup.procs",
        "pids.current",
    ):
        try:
            value = (group / name).read_text().strip()
            if name == "memory.stat":
                value = "\n".join(
                    line
                    for line in value.splitlines()
                    if line.split()[0]
                    in (
                        "anon",
                        "file",
                        "kernel",
                        "shmem",
                        "anon_thp",
                        "pgfault",
                        "pgmajfault",
                        "pgscan_direct",
                        "pgsteal_direct",
                    )
                )
            snapshot[name] = value
        except OSError as error:
            snapshot[name] = str(error)
    processes: dict[str, object] = {}
    try:
        pids = (group / "cgroup.procs").read_text().split()
    except OSError:
        pids = []
    for pid in pids:
        proc: dict[str, str] = {}
        for name in ("status", "wchan", "stack"):
            try:
                value = (Path("/proc") / pid / name).read_text().strip()
                if name == "status":
                    value = "\n".join(
                        line
                        for line in value.splitlines()
                        if line.split(":", 1)[0]
                        in (
                            "Name",
                            "State",
                            "Tgid",
                            "Pid",
                            "PPid",
                            "NSpid",
                            "VmSize",
                            "VmRSS",
                            "RssAnon",
                            "Threads",
                        )
                    )
                proc[name] = value
            except OSError as error:
                proc[name] = str(error)
        processes[pid] = proc
    snapshot["processes"] = processes
    return snapshot


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
        # A unique fixture slice retains hierarchical OOM counters after systemd
        # removes the dead service cgroup. Its limits stay unlimited.
        memory = mode in ("parent-memory", "child-memory")
        slice_name = name + ".slice"
        unit_root = Path("/run/systemd/system")
        service_path, target_path = unit_root / service, unit_root / target
        slice_path = unit_root / slice_name
        # TemporaryDirectory is the only source of data paths. No shop originals or DB.
        with (
            tempfile.TemporaryDirectory(
                prefix="korzina-image-systemd-", delete=False
            ) as temporary,
            ExitStack() as descriptors,
        ):
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
            if memory:
                body += f"Slice={slice_name}\n"
                with slice_path.open("x") as handle:
                    handle.write("[Slice]\nMemoryAccounting=yes\nDelegate=no\n")
            pin = f"[Unit]\nWants={service}\nAfter={service}\nRefuseManualStop=yes\nIgnoreOnIsolate=yes\n"
            with service_path.open("x") as handle:
                handle.write(body)
            with target_path.open("x") as handle:
                handle.write(pin)
            group: Path | None = None
            slice_group: Path | None = None
            memory_before: dict[str, int] = {}
            last_sample = 0.0
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
                self.assertGreaterEqual(
                    len(pids),
                    2 if mode in ("orphan", "child-memory") else 3,
                    "child/grandchild/setsid must remain contained",
                )
                pidfds = [os.pidfd_open(int(pid)) for pid in pids]
                for fd in pidfds:
                    descriptors.callback(os.close, fd)
                self.assertEqual(values["Restart"], "no")
                self.assertEqual(values["KillMode"], "control-group")
                if memory:
                    slice_group = Path("/sys/fs/cgroup") / runner.show(slice_name)[
                        "ControlGroup"
                    ].lstrip("/")
                    self.assertEqual(
                        (slice_group / "memory.high").read_text().strip(), "max"
                    )
                    self.assertEqual(
                        (slice_group / "memory.max").read_text().strip(), "max"
                    )
                    memory_before = counters(slice_group, "memory.events")
                    print(
                        "OOM_SAMPLE="
                        + json.dumps(
                            {
                                "mode": mode,
                                "phase": "before",
                                "group": str(group),
                                "transparentHugepage": Path(
                                    "/sys/kernel/mm/transparent_hugepage/enabled"
                                )
                                .read_text()
                                .strip(),
                                "snapshot": memory_snapshot(group),
                            },
                            sort_keys=True,
                        ),
                        flush=True,
                    )
                if mode in ("cpu", "tasks"):
                    self.check_pressure(mode, group, data)
                self.assertEqual(values["NFileDescriptorStore"], "1")
                with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                    runner.acquire_fence(fence)
                self.assertNotEqual(self.command("stop", target).returncode, 0)
                # A reload cannot drop the manager's stored open file description.
                self.assertEqual(self.command("daemon-reload").returncode, 0)
                self.assertEqual(runner.show(service)["NFileDescriptorStore"], "1")
                if memory:
                    (data / "start").write_text("start", encoding="ascii")
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
                    if memory and time.monotonic() - last_sample >= 5:
                        last_sample = time.monotonic()
                        print(
                            "OOM_SAMPLE="
                            + json.dumps(
                                {
                                    "mode": mode,
                                    "phase": "running",
                                    "snapshot": memory_snapshot(group),
                                },
                                sort_keys=True,
                            ),
                            flush=True,
                        )
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
                exited = select.select(pidfds, [], [], 0)[0]
                self.assertEqual(
                    len(exited), len(pidfds), "fixture descendants survived"
                )
                memory_delta: dict[str, int] = {}
                if memory and slice_group is not None:
                    memory_after = counters(slice_group, "memory.events")
                    memory_delta = {
                        key: value - memory_before[key]
                        for key, value in memory_after.items()
                    }
                    journal = subprocess.run(
                        [
                            "journalctl",
                            "--boot",
                            "--no-pager",
                            "--output=cat",
                            "--lines=50",
                            "--unit",
                            service,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=True,
                    )
                    with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                        runner.acquire_fence(fence)
                    print(
                        "OOM_DIAGNOSTIC="
                        + json.dumps(
                            {
                                "mode": mode,
                                "result": current["Result"],
                                "eventsBefore": memory_before,
                                "eventsAfter": memory_after,
                                "eventsDelta": memory_delta,
                                "snapshot": memory_snapshot(group),
                                "quiescent": quiescent,
                                "initialPids": pids,
                                "pidfdsExited": len(exited),
                                "mainPid": current["MainPID"],
                                "fdStore": runner.show(service)["NFileDescriptorStore"],
                                "pin": runner.show(target)["ActiveState"],
                                "restarts": current["NRestarts"],
                                "fence": "BUSY",
                                "fenceIdentity": [
                                    fence.stat().st_dev,
                                    fence.stat().st_ino,
                                ],
                                "journal": journal.stdout,
                            },
                            sort_keys=True,
                        ),
                        flush=True,
                    )
                    self.assertEqual(current["Result"], "oom-kill")
                    self.assertGreater(memory_delta["max"], 0)
                    self.assertGreater(memory_delta["oom_kill"], 0)
                    self.assertGreater(memory_delta["oom_group_kill"], 0)
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
                            "initialPids": pids,
                            "pidfdsExited": len(exited),
                            "fdStore": runner.show(service)["NFileDescriptorStore"],
                            "restarts": runner.show(service)["NRestarts"],
                            "memoryEventsDelta": memory_delta,
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
                    self.assertEqual(runner.show(service)["NFileDescriptorStore"], "0")
                    released = runner.acquire_fence(fence)
                    os.close(released)
                    print(
                        "FENCE_RELEASE_EVIDENCE="
                        + json.dumps(
                            {
                                "mode": mode,
                                "quiescent": quiescent,
                                "fdStore": "0",
                                "fence": "FREE_AFTER_EXPLICIT_CLEAN",
                                "identity": [
                                    current_fence.st_dev,
                                    current_fence.st_ino,
                                    current_fence.st_nlink,
                                ],
                            },
                            sort_keys=True,
                        ),
                        flush=True,
                    )
                    target_path.write_text(
                        pin.replace("RefuseManualStop=yes", "RefuseManualStop=no")
                    )
                    self.command("daemon-reload")
                    self.command("stop", target)
                    self.command("reset-failed", service)
                    service_path.unlink()
                    target_path.unlink()
                    if memory:
                        self.assertEqual(self.command("stop", slice_name).returncode, 0)
                        slice_path.unlink()
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
        if mode == "cpu":
            before = counters(group, "cpu.stat")
            start = time.monotonic()
            (data / "start").write_text("start")
            time.sleep(3)
            elapsed = time.monotonic() - start
            after = counters(group, "cpu.stat")
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
            self.assertGreater(counters(group, "pids.events")["max"], 0)
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
