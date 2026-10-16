"""Fixed namespace probes for disposable synthetic files; never an image publisher."""

import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
from collections.abc import Callable

import launcher as runner

UID = 55000
SOURCE = Path("/storage/products/550e8400-e29b-41d4-a716-446655440001.webp")
STATE = Path("/storage/.product-image-state")
VARIANTS = Path("/storage/product-variants")


def fingerprint(path: Path) -> tuple[object, ...]:
    info = path.stat()
    return (
        hashlib.sha256(path.read_bytes()).hexdigest(),
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_uid,
        info.st_gid,
        info.st_mode,
        info.st_nlink,
    )


def denied(operation: Callable[[], object]) -> None:
    # Operations are fixed callables below, never deserialized commands or paths.
    try:
        operation()
    except OSError as error:
        assert error.errno in (errno.EROFS, errno.EACCES, errno.EPERM, errno.EXDEV)
    else:
        raise AssertionError("mutation unexpectedly succeeded")


def worker() -> dict[str, object]:
    assert os.getuid() == UID and os.getgid() == UID and os.getgroups() == []
    assert os.getresuid() == (UID, UID, UID) and os.getresgid() == (UID, UID, UID)
    status = dict(
        line.split(":", 1)
        for line in Path("/proc/self/status").read_text().splitlines()
        if ":" in line
    )
    assert status["NoNewPrivs"].strip() == "1" and status["Seccomp"].strip() == "2"
    assert all(
        int(status[key], 16) == 0 for key in ("CapEff", "CapPrm", "CapAmb", "CapInh")
    )
    assert int(status["CapBnd"], 16) == 0xE4  # A ceiling, not usable privileges.
    assert set(os.environ) <= {"PATH", "LANG"}
    config = json.loads(Path("/input/request.json").read_text())
    for name, identity in config["hostNamespaces"].items():
        assert os.readlink(f"/proc/self/ns/{name}") != identity
    try:
        channel = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except OSError as error:
        assert error.errno in (errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES)
    else:
        channel.close()
        raise AssertionError("network address family was not restricted")
    before = fingerprint(SOURCE)
    inventory = Path("/input/inventory.jsonl")
    inventory_before = fingerprint(inventory)
    for action in (
        lambda: SOURCE.open("wb"),
        lambda: os.truncate(SOURCE, 0),
        SOURCE.unlink,
        lambda: SOURCE.rename(SOURCE.with_suffix(".moved")),
        lambda: SOURCE.chmod(0o644),
        lambda: os.link(SOURCE, VARIANTS / "original-alias"),
        lambda: inventory.open("wb"),
        inventory.unlink,
        lambda: inventory.chmod(0o644),
        lambda: Path("/storage/outside-scope").write_bytes(b"denied"),
        lambda: Path("/storage/chat/outside-scope").write_bytes(b"denied"),
        lambda: VARIANTS.rename(Path("/storage/moved-variants")),
        lambda: Path("/etc/outside-scope").write_bytes(b"denied"),
        lambda: Path("/artifact/outside-scope").write_bytes(b"denied"),
        lambda: list(Path("/proc/sys/fs/binfmt_misc").iterdir()),
        lambda: list(Path("/dev/mqueue").iterdir()),
        lambda: list(Path("/dev/hugepages").iterdir()),
        lambda: list(Path("/dev/shm").iterdir()),
        lambda: list(Path("/dev/pts").iterdir()),
    ):
        denied(action)
    assert fingerprint(SOURCE) == before and fingerprint(inventory) == inventory_before
    assert not Path(config["outsideSecret"]).exists()
    for path in (
        "/etc/fixture-api.env",
        "/root/.env",
        "/artifact/.env",
        "/artifact/apps/api/.env",
    ):
        assert not Path(path).exists()
    with socket.socket(socket.AF_UNIX) as channel:
        denied(lambda: channel.connect("/run/systemd/private"))
    # Foreign host UID is identical, but PID/proc namespace must hide it.
    foreign = config["foreignPid"]
    assert not Path(f"/proc/{foreign}").exists()
    assert {int(p.name) for p in Path("/proc").iterdir() if p.name.isdigit()} <= {
        1,
        os.getpid(),
    }
    pid = os.fork()
    if pid == 0:
        libc = ctypes.CDLL(None, use_errno=True)
        result = libc.ptrace(0x4206, foreign, None, None)  # PTRACE_SEIZE
        os._exit(
            0
            if result == -1 and ctypes.get_errno() in (errno.EPERM, errno.ESRCH)
            else 1
        )
    _, code = os.waitpid(pid, 0)
    assert code == 0 or (os.WIFSIGNALED(code) and os.WTERMSIG(code) == signal.SIGSYS)
    # Unknown locks remain byte/inode/mtime identical; no PID or age heuristic.
    lock = STATE / "locks/unknown.lock"
    lock_before = fingerprint(lock)
    try:
        runner.unknown_locks(STATE)
    except runner.Refused as error:
        assert str(error) == "BUSY"
    else:
        raise AssertionError("unknown lock admitted")
    assert fingerprint(lock) == lock_before
    temporary = STATE / "work/exclusive"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, b"synthetic no-clobber link probe")
        os.fsync(fd)
    finally:
        os.close(fd)
    output = VARIANTS / "link-probe"
    os.link(temporary, output, follow_symlinks=False)
    assert output.stat().st_ino == temporary.stat().st_ino
    assert output.stat().st_mode & 0o777 == 0o600
    try:
        os.link(temporary, output, follow_symlinks=False)
    except FileExistsError:
        pass
    else:
        raise AssertionError("no-clobber failed")
    assert output.read_bytes() == temporary.read_bytes()
    for folder in (temporary.parent, output.parent):
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return {
        "credentials": {
            "uids": os.getresuid(),
            "gids": os.getresgid(),
            "groups": os.getgroups(),
            "caps": {
                key: status[key].strip()
                for key in ("CapEff", "CapPrm", "CapAmb", "CapInh", "CapBnd")
            },
            "noNewPrivileges": status["NoNewPrivs"].strip(),
            "seccomp": status["Seccomp"].strip(),
        },
        "roOriginalsInventory": "PASSED",
        "originalFingerprint": list(before),
        "uidCapsEnvSecrets": "PASSED",
        "foreignProcPtrace": "PASSED",
        "unknownLock": "BUSY_PRESERVED",
        "nativeLinkFsyncNoClobber": "PASSED",
    }


def supervisor(mode: str) -> dict[str, object]:
    assert os.geteuid() == 0 and os.getpid() == 1
    runner.pid_namespace(os.getpid(), os.readlink("/proc/self"))
    runner.process_policy(Path("/proc/self/status").read_text())
    runner.environment_policy(set(os.environ))
    identity = {
        name: Path(f"/proc/self/{name}").read_text().strip()
        for name in ("uid_map", "gid_map", "setgroups")
    }
    print("FIXTURE_IDENTITY=" + json.dumps(identity, sort_keys=True), flush=True)
    assert identity["setgroups"] == "allow"
    raw = Path("/proc/self/mountinfo").read_text()
    print("FIXTURE_MOUNTS=" + json.dumps(raw.splitlines()), flush=True)
    grouped: dict[str, list[str]] = {}
    for line in raw.splitlines():
        grouped.setdefault(line.split()[4], []).append(line)
    duplicates = {key: value for key, value in grouped.items() if len(value) > 1}
    if duplicates:
        print(
            "FIXTURE_STACKED_MOUNTS=" + json.dumps(duplicates, sort_keys=True),
            file=sys.stderr,
            flush=True,
        )
    items = runner.mounts(raw)
    for path in (
        "/proc/sys/fs/binfmt_misc",
        "/dev/mqueue",
        "/dev/hugepages",
        "/dev/shm",
        "/dev/pts",
    ):
        hidden = runner.mount_at(items, path)
        assert hidden.path == path and hidden.kind == "tmpfs"
        assert {"ro", "nosuid", "nodev", "noexec"} <= hidden.options
        assert Path(path).stat().st_mode & 0o777 == 0
        assert not list(Path(path).iterdir())
    if mode in ("exdev", "alias"):
        try:
            runner.mount_policy(items)
        except runner.Refused as error:
            expected = "LINK_MOUNT_MISMATCH" if mode == "exdev" else "WRITABLE_ALIAS"
            assert str(error) == expected, str(error)
        else:
            raise AssertionError("unsafe mount topology admitted")
        if mode == "exdev":
            # Probe as the unprivileged fixture identity, no fallback of any kind.
            child = subprocess.run(
                [
                    "/usr/bin/python3",
                    "-B",
                    "/opt/image-runner/fs_payload.py",
                    "exdev-worker",
                ],
                user=UID,
                group=UID,
                extra_groups=[],
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=10,
                check=False,
            )
            assert child.returncode == 0, child.stderr.decode(errors="replace")
        return {
            "negativeMount": mode,
            "result": expected,
            "nativeExdev": mode == "exdev",
        }
    checked = runner.mount_policy(items)
    runner.storage_policy(UID, UID)
    group = Path("/sys/fs/cgroup") / runner.cgroup_path(
        Path("/proc/self/cgroup").read_text()
    ).lstrip("/")
    limits = runner.cgroup_policy(
        {
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
    )
    fd = runner.acquire_fence(Path("/control/deploy.lock"))
    try:
        runner.notify_store(fd, os.environ.get("NOTIFY_SOCKET", ""))
    finally:
        os.close(fd)  # Only the real manager retains admission for the child.
    child = subprocess.run(
        ["/usr/bin/python3", "-B", "/opt/image-runner/fs_payload.py", "worker"],
        user=UID,
        group=UID,
        extra_groups=[],
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        close_fds=True,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=20,
        check=False,
    )
    assert child.returncode == 0, child.stderr.decode(errors="replace")
    return {
        "namespaceMountPolicy": checked,
        "binfmt": "INACCESSIBLE_RO_MODE_0000",
        "mqueue": "INACCESSIBLE_RO_MODE_0000",
        "hugepages": "INACCESSIBLE_RO_MODE_0000",
        "sharedMemoryTerminals": "INACCESSIBLE_RO_MODE_0000",
        "notifySocket": os.environ.get("NOTIFY_SOCKET", ""),
        "identity": identity,
        "limits": limits,
        "worker": json.loads(child.stdout),
    }


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "worker":
        print(json.dumps(worker()), flush=True)
    elif mode == "exdev-worker":
        temporary = STATE / "work/exdev-probe"
        temporary.write_bytes(b"synthetic EXDEV probe")
        try:
            os.link(temporary, VARIANTS / "must-not-exist")
        except OSError as error:
            assert error.errno == errno.EXDEV
            assert not (VARIANTS / "must-not-exist").exists()
        else:
            raise AssertionError("separate mounts unexpectedly allowed link")
    else:
        print(
            "NAMESPACE_RESULT=" + json.dumps(supervisor(mode), sort_keys=True),
            flush=True,
        )
