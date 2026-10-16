"""Acceptance environment evidence; an opt-in is authorization, never attestation."""

import os
from pathlib import Path
import subprocess
import stat
import sys

import launcher as runner


def policy(pid1: str, version: int, controllers: set[str], namespaces: int) -> None:
    runner.require(pid1 == "systemd" and version >= 258, "SYSTEMD_258_REQUIRED")
    runner.require(
        {"memory", "cpu", "pids"} <= controllers, "CGROUP_CONTROLLERS_REQUIRED"
    )
    runner.require(namespaces > 0, "PID_NAMESPACES_REQUIRED")


def host_cgroup_mount(value: str) -> None:
    """Host admission only. Strict runner namespace checks remain unchanged."""
    runner.require(len(value) <= 1024**2, "CGROUP_V2_REQUIRED")
    kinds: list[str] = []
    for line in value.splitlines():
        left, right = line.split(" - ", 1)
        if left.split()[4] == "/sys/fs/cgroup":
            kinds.append(right.split()[0])
    runner.require(
        bool(kinds) and all(kind == "cgroup2" for kind in kinds), "CGROUP_V2_REQUIRED"
    )


def evidence() -> dict[str, object]:
    runner.require(
        sys.platform == "linux" and os.geteuid() == 0, "DISPOSABLE_ROOT_LINUX_REQUIRED"
    )
    runner.require(
        os.environ.get("KORZINA_DISPOSABLE_SYSTEMD") == "1",
        "DISPOSABLE_OPT_IN_REQUIRED",
    )
    marker = Path("/etc/image-acceptance-disposable")
    info = marker.lstat()
    runner.require(
        marker.resolve() == marker
        and stat.S_ISREG(info.st_mode)
        and info.st_uid == 0
        and info.st_nlink == 1
        and info.st_mode & 0o777 == 0o600
        and marker.read_text() == "isolated-image-fixtures-v1\n",
        "DISPOSABLE_VM_MARKER_REQUIRED",
    )
    version = subprocess.run(
        ["systemctl", "--version"],
        capture_output=True,
        text=True,
        timeout=3,
        check=True,
    )
    controllers = set(Path("/sys/fs/cgroup/cgroup.controllers").read_text().split())
    policy(
        Path("/proc/1/comm").read_text().strip(),
        int(version.stdout.split()[1]),
        controllers,
        int(Path("/proc/sys/user/max_pid_namespaces").read_text()),
    )
    # Host boot mounts can legitimately be stacked. The strict mount/alias parser
    # belongs INSIDE the runner namespace, not on the disposable VM's host root.
    host_cgroup_mount(Path("/proc/self/mountinfo").read_text())
    # Real namespace creation, not inference from version, config or GitHub labels.
    probe = subprocess.run(
        [
            "unshare",
            "--mount",
            "--pid",
            "--fork",
            "--mount-proc",
            "/usr/bin/python3",
            "-c",
            "import os; from pathlib import Path; assert os.getpid()==1; "
            "assert Path('/proc/1/comm').read_text().strip()=='python3'",
        ],
        capture_output=True,
        timeout=10,
        check=False,
    )
    runner.require(probe.returncode == 0, "NAMESPACE_PERMISSION_UNVERIFIED")
    return {
        "pid1": "systemd",
        "systemd": version.stdout.splitlines()[0],
        "kernel": os.uname().release,
        "controllers": sorted(controllers),
        "cgroup": "v2",
        "namespaceCreation": "PASSED",
    }


def available() -> bool:
    try:
        evidence()
        return True
    except (
        OSError,
        ValueError,
        IndexError,
        runner.Refused,
        subprocess.SubprocessError,
    ):
        return False
