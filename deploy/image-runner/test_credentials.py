"""Minimal systemd CAP_SETUID/NNP regression in the marked disposable VM only."""

import ctypes
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid

import launcher as runner
import preflight

UID = 55000
CAPS = ("CapPrm", "CapEff", "CapBnd", "CapInh", "CapAmb")


def credentials() -> dict[str, object]:
    status = dict(
        line.split(":", 1)
        for line in Path("/proc/self/status").read_text().splitlines()
        if ":" in line
    )
    return {
        "uids": os.getresuid(),
        "gids": os.getresgid(),
        "groups": os.getgroups(),
        "caps": {key: int(status[key].strip(), 16) for key in CAPS},
        "noNewPrivileges": int(status["NoNewPrivs"]),
        "seccomp": int(status["Seccomp"]),
    }


def transition() -> dict[str, object]:
    steps: dict[str, int] = {}
    for name, operation in (
        ("setgroups", lambda: os.setgroups([])),
        ("setgid", lambda: os.setgid(UID)),
        ("setuid", lambda: os.setuid(UID)),
    ):
        try:
            operation()
        except OSError as error:
            steps[name] = error.errno
            break
        steps[name] = 0
    return {"steps": steps, "after": credentials()}


def worker() -> dict[str, object]:
    before = credentials()
    assert os.getresuid() == (UID, UID, UID) and os.getresgid() == (UID, UID, UID)
    assert not os.getgroups()
    assert before["caps"] == {
        "CapPrm": 0,
        "CapEff": 0,
        "CapBnd": 0xE4,
        "CapInh": 0,
        "CapAmb": 0,
    }
    assert before["noNewPrivileges"] == 1 and before["seccomp"] == 2
    try:
        os.setuid(0)
    except OSError as error:
        assert error.errno == errno.EPERM
    else:
        raise AssertionError("worker regained root")

    # A nonzero bounding ceiling cannot restore a capability removed from P/E.
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [
            ("effective", ctypes.c_uint32),
            ("permitted", ctypes.c_uint32),
            ("inheritable", ctypes.c_uint32),
        ]

    libc = ctypes.CDLL(None, use_errno=True)
    header = Header(0x20080522, 0)
    data = (Data * 2)(Data(0x80, 0x80, 0), Data())
    assert libc.capset(ctypes.byref(header), ctypes.byref(data)) == -1
    assert ctypes.get_errno() == errno.EPERM
    assert credentials() == before
    return before


def probe() -> dict[str, object]:
    assert os.geteuid() == 0
    before = credentials()
    try:
        runner.process_policy(Path("/proc/self/status").read_text())
    except runner.Refused as error:
        admission = str(error)
    else:
        admission = "PASSED"
    command = [sys.executable, "-B", str(Path(__file__).resolve())]
    dropped = subprocess.run(
        command + ["transition"], capture_output=True, check=True, timeout=5
    )
    try:
        child = subprocess.run(
            command + ["worker"],
            user=UID,
            group=UID,
            extra_groups=[],
            close_fds=True,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=True,
            timeout=5,
        )
    except PermissionError as error:
        spawned = {"errno": error.errno}
    else:
        spawned = {"errno": 0, "worker": json.loads(child.stdout)}
    return {
        "supervisor": before,
        "admission": admission,
        "transition": json.loads(dropped.stdout),
        "spawn": spawned,
    }


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class CredentialTests(unittest.TestCase):
    def case(self, explicit: bool) -> None:
        name = "image-credentials-fixture-" + uuid.uuid4().hex + ".service"
        path = Path("/run/systemd/system") / name
        identity = "User=root\n" if explicit else ""
        body = f"""[Service]
Type=exec
{identity}Group=root
ExecStart=/usr/bin/python3 -B {Path(__file__).resolve()} probe
RemainAfterExit=yes
Restart=no
RuntimeMaxSec=20
TimeoutStopSec=1
KillMode=control-group
SendSIGKILL=yes
MemoryMax=128M
MemorySwapMax=0
CPUQuota=50%
TasksMax=16
LimitCORE=0
NoNewPrivileges=yes
PrivateUsers=full
PrivatePIDs=yes
PrivateMounts=yes
PrivateNetwork=yes
ProtectSystem=strict
ProtectHome=yes
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_READ_SEARCH CAP_KILL
AmbientCapabilities=
RestrictSUIDSGID=yes
RestrictNamespaces=yes
SystemCallArchitectures=native
SystemCallFilter=~@mount @reboot @swap @module @raw-io @clock @debug
"""
        with path.open("x") as handle:
            handle.write(body)

        def command(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["systemctl", *args],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            )

        quiescent = False
        try:
            command("daemon-reload")
            command("start", name)
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                values = runner.show(name)
                group = (
                    Path("/sys/fs/cgroup") / values["ControlGroup"].lstrip("/")
                    if values["ControlGroup"]
                    else None
                )
                if values["MainPID"] == "0" and (
                    group is None
                    or not group.exists()
                    or "populated 0" in (group / "cgroup.events").read_text()
                ):
                    quiescent = True
                    break
                time.sleep(0.05)
            logs = subprocess.check_output(
                ["journalctl", "--unit", name, "--no-pager", "-o", "cat"],
                text=True,
                timeout=5,
            )
            self.assertTrue(quiescent, logs)
            self.assertEqual(values["Result"], "success", logs)
            self.assertEqual(values["User"], "root" if explicit else "")
            self.assertEqual(values["Group"], "root")
            reports = [
                json.loads(line.split("UID_RESULT=", 1)[1])
                for line in logs.splitlines()
                if "UID_RESULT=" in line
            ]
            self.assertEqual(len(reports), 1, logs)
            report = reports[0]
            supervisor = report["supervisor"]
            self.assertEqual(supervisor["uids"], [0, 0, 0])
            self.assertEqual(supervisor["gids"], [0, 0, 0])
            self.assertEqual(supervisor["noNewPrivileges"], 1)
            self.assertEqual(supervisor["seccomp"], 2)
            self.assertEqual(
                supervisor["caps"],
                {
                    "CapPrm": 0x64 if explicit else 0xE4,
                    "CapEff": 0x64 if explicit else 0xE4,
                    "CapBnd": 0xE4,
                    "CapInh": 0,
                    "CapAmb": 0,
                },
            )
            self.assertEqual(
                report["admission"],
                "PROCESS_POLICY_UNVERIFIED" if explicit else "PASSED",
            )
            self.assertEqual(
                report["transition"]["steps"],
                {"setgroups": 0, "setgid": 0, "setuid": errno.EPERM if explicit else 0},
            )
            self.assertEqual(report["spawn"]["errno"], errno.EPERM if explicit else 0)
            if not explicit:
                worker_status = report["spawn"]["worker"]
                self.assertEqual(worker_status["uids"], [UID, UID, UID])
                self.assertEqual(worker_status["gids"], [UID, UID, UID])
                self.assertEqual(worker_status["groups"], [])
                self.assertEqual(
                    worker_status["caps"],
                    {
                        "CapPrm": 0,
                        "CapEff": 0,
                        "CapInh": 0,
                        "CapAmb": 0,
                        "CapBnd": 0xE4,
                    },
                )
                self.assertEqual(worker_status["noNewPrivileges"], 1)
                self.assertEqual(worker_status["seccomp"], 2)
            print(
                "CREDENTIAL_EVIDENCE="
                + json.dumps({"explicitUser": explicit, **report}, sort_keys=True),
                flush=True,
            )
        finally:
            if quiescent:
                command("stop", name)
                path.unlink()
                command("daemon-reload")
            else:
                self.fail(
                    "NOT VERIFIED: retain credential fixture for disposable VM teardown"
                )

    def test_explicit_root_seccomp_loses_setuid(self) -> None:
        self.case(True)

    def test_inherited_root_seccomp_drops_worker_privileges(self) -> None:
        self.case(False)


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] in ("probe", "transition", "worker"):
        mode = sys.argv[1]
        if mode != "worker":
            assert sys.platform == "linux" and os.geteuid() == 0
            # Authorization only; the test class separately requires real host
            # preflight. Root probes cannot be run by accident on an ordinary host.
            assert (
                Path("/etc/image-acceptance-disposable").read_text()
                == "isolated-image-fixtures-v1\n"
            )
        report = (
            probe()
            if mode == "probe"
            else transition()
            if mode == "transition"
            else worker()
        )
        print(
            ("UID_RESULT=" if mode == "probe" else "")
            + json.dumps(report, sort_keys=True),
            flush=True,
        )
    else:
        unittest.main()
