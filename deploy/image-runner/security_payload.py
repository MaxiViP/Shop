"""Fixed probes for new, marked disposable VM fixtures. Never a publisher."""

import ctypes
from collections.abc import Callable
import errno
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

UID = 55000
CAPS = ("CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd")
MARKER = "disposable-security-fixture-v1\n"
CODE = (
    "import json,os; from pathlib import Path; "
    "s=dict(l.split(':',1) for l in Path('/proc/self/status').read_text().splitlines() if ':' in l); "
    "print(json.dumps({'uids':os.getresuid(),'gids':os.getresgid(),'groups':os.getgroups(),"
    "'caps':{k:int(s[k],16) for k in ('CapEff','CapPrm','CapInh','CapAmb','CapBnd')},"
    "'nnp':int(s['NoNewPrivs']),'seccomp':int(s['Seccomp'])}))"
)


def identity() -> dict[str, object]:
    fields = dict(
        line.split(":", 1)
        for line in Path("/proc/self/status").read_text().splitlines()
        if ":" in line
    )
    return {
        "uids": list(os.getresuid()),
        "gids": list(os.getresgid()),
        "groups": os.getgroups(),
        "caps": {key: int(fields[key], 16) for key in CAPS},
        "nnp": int(fields["NoNewPrivs"]),
        "seccomp": int(fields["Seccomp"]),
    }


def unprivileged(value: dict[str, object]) -> None:
    assert value["uids"] == value["gids"] == [UID, UID, UID]
    assert value["groups"] == [] and value["nnp"] == 1
    assert value["seccomp"] == 2
    assert value["caps"] == {
        "CapEff": 0,
        "CapPrm": 0,
        "CapInh": 0,
        "CapAmb": 0,
        "CapBnd": 0xE4,
    }


def fixture_marker(path: Path) -> None:
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
    assert info.st_mode & 0o777 == 0o444 and info.st_size == len(MARKER)
    assert path.read_text() == MARKER


def exec_bounds() -> dict[str, object]:
    before = identity()
    unprivileged(before)
    libc = ctypes.CDLL(None, use_errno=True)
    denied: dict[str, int] = {}

    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [
            ("effective", ctypes.c_uint32),
            ("permitted", ctypes.c_uint32),
            ("inheritable", ctypes.c_uint32),
        ]

    header = Header(0x20080522, 0)
    requested = (Data * 2)(Data(0xE4, 0xE4, 0xE4), Data())
    ctypes.set_errno(0)
    assert libc.capset(ctypes.byref(header), ctypes.byref(requested)) == -1
    denied["capset"] = ctypes.get_errno()
    assert denied["capset"] == errno.EPERM
    for name, operation in (
        ("setuid", lambda: os.setresuid(0, 0, 0)),
        ("setgid", lambda: os.setresgid(0, 0, 0)),
        ("setgroups", lambda: os.setgroups([0])),
    ):
        try:
            operation()
        except OSError as error:
            assert error.errno == errno.EPERM
            denied[name] = error.errno
        else:
            raise AssertionError(name + " unexpectedly succeeded")
    # PR_CAP_AMBIENT_RAISE(CAP_SETUID), PR_CAPBSET_DROP, PR_SET_NO_NEW_PRIVS(0).
    for name, arguments in (
        ("ambientRaise", (47, 2, 7, 0, 0)),
        ("boundingDropWithoutSetpcap", (24, 7, 0, 0, 0)),
        ("clearNnp", (38, 0, 0, 0, 0)),
    ):
        ctypes.set_errno(0)
        assert libc.prctl(*arguments) == -1
        denied[name] = ctypes.get_errno()
        assert denied[name] == (errno.EINVAL if name == "clearNnp" else errno.EPERM)
    results = {}
    for name in ("plain", "suid", "fcap"):
        child = subprocess.run(
            ["/opt/security/bin/" + name, "-I", "-B", "-c", CODE],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=True,
            timeout=5,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            close_fds=True,
        )
        value = json.loads(child.stdout)
        unprivileged(value)
        results[name] = value
    assert identity() == before
    return {"before": before, "denied": denied, "exec": results}


def worker(mode: str) -> dict[str, object]:
    fixture_marker(Path("/etc/image-security-fixture"))
    unprivileged(identity())
    pid = os.getpid()
    assert pid > 1 and os.getppid() == 1
    assert os.readlink("/proc/self") == str(pid)
    assert {
        int(path.name) for path in Path("/proc").iterdir() if path.name.isdigit()
    } == {
        1,
        pid,
    }
    if mode == "caps-worker":
        return exec_bounds()
    ready = Path("/storage/.product-image-state/work/worker-ready")
    ready.write_text("ready")
    deadline = time.monotonic() + 100
    while not ready.with_name("finish").exists():
        assert time.monotonic() < deadline, "boundary fixture control timeout"
        time.sleep(0.02)
    return {"identity": identity(), "complete": True}


def supervisor(mode: str) -> dict[str, object]:
    fixture_marker(Path("/etc/image-security-fixture"))
    assert os.geteuid() == 0 and os.getpid() == 1
    before = identity()
    assert before["nnp"] == 1 and before["seccomp"] == 2
    assert before["caps"] == {
        "CapEff": 0xE4,
        "CapPrm": 0xE4,
        "CapInh": 0,
        "CapAmb": 0,
        "CapBnd": 0xE4,
    }
    child = subprocess.run(
        [
            "/usr/bin/python3",
            "-I",
            "-B",
            str(Path(__file__).resolve()),
            mode + "-worker",
        ],
        user=UID,
        group=UID,
        extra_groups=[],
        close_fds=True,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=110,
    )
    assert child.returncode == 0, child.stderr.decode(errors="replace")[:8192]
    return json.loads(child.stdout)


def attempt(operation: Callable[[], object]) -> dict[str, object]:
    try:
        operation()
    except OSError as error:
        assert error.errno in (
            errno.EACCES,
            errno.EPERM,
            errno.EROFS,
            errno.EXDEV,
            errno.ENOENT,
            errno.ESRCH,
        )
        return {"allowed": False, "errno": error.errno}
    return {"allowed": True}


def api(path: Path) -> dict[str, object]:
    # Only root-created, marker-pinned /var/tmp fixtures are accepted. Never shop paths.
    assert sys.platform == "linux" and os.geteuid() == UID
    info = Path("/etc/image-acceptance-disposable").stat()
    assert info.st_uid == 0 and info.st_mode & 0o777 == 0o600
    assert path.resolve(strict=True) == path and path.name == "api.json"
    assert path.stat().st_uid == 0 and path.stat().st_size < 8192
    root = path.parents[2]
    assert root.parent == Path("/var/tmp") and root.name.startswith(
        "image-security-fixture-"
    )
    fixture_marker(root / "marker")
    config = json.loads(path.read_text())
    assert config["rootIdentity"] == [root.stat().st_dev, root.stat().st_ino]
    storage = path.parent / "uploads"
    assert storage.resolve() == storage
    results: dict[str, object] = {}
    value = identity()
    assert value["uids"] == value["gids"] == [UID, UID, UID]
    assert value["nnp"] == 1
    assert all(
        value["caps"][key] == 0 for key in ("CapEff", "CapPrm", "CapInh", "CapAmb")
    )
    pid = os.getpid()
    visible = {int(p.name) for p in Path("/proc").iterdir() if p.name.isdigit()}
    assert os.readlink("/proc/self") == str(pid)
    assert {1, pid} == visible, {"pid": pid, "visible": sorted(visible)}
    results["pidNamespace"] = {"pid": pid, "visible": sorted(visible)}
    fields = dict(
        line.split(":", 1)
        for line in Path("/proc/self/status").read_text().splitlines()
        if ":" in line
    )
    assert int(fields["Umask"], 8) == 0o027
    mounts = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        parts = line.split(" - ", 1)[0].split()
        mounts.append(
            {"id": int(parts[0]), "path": parts[4], "options": parts[5].split(",")}
        )
    topology = {}
    for name in (".", "products", "chat", "product-variants", ".product-image-state"):
        target = storage / name
        mount = max(
            (m for m in mounts if target.is_relative_to(m["path"])),
            key=lambda m: len(Path(m["path"]).parts),
        )
        info = target.stat()
        assert info.st_uid == info.st_gid == (0 if name == "." else UID)
        assert stat.S_IMODE(info.st_mode) == (
            0o755 if name == "." else 0o750 if name in ("products", "chat") else 0o700
        )
        assert (
            "ro" if name in ("product-variants", ".product-image-state") else "rw"
        ) in mount["options"]
        topology[name] = {
            **mount,
            "uid": info.st_uid,
            "gid": info.st_gid,
            "mode": oct(stat.S_IMODE(info.st_mode)),
        }
    assert topology["products"]["id"] == topology["chat"]["id"] == topology["."]["id"]
    assert all(
        topology[name]["id"] != topology["."]["id"]
        for name in ("product-variants", ".product-image-state")
    )
    results["topology"] = topology
    for directory in ("product-variants", ".product-image-state"):
        parent = storage / directory
        assert (parent / "read").read_bytes() == b"synthetic-security-storage-v1"
        results[directory] = {
            "create": attempt(
                lambda: (parent / "new-file").write_bytes(b"must-not-exist")
            ),
            "mkdir": attempt(lambda: (parent / "new-directory").mkdir()),
            "write": attempt(
                lambda: (parent / "write").write_bytes(b"synthetic-api-write")
            ),
            "chmod": attempt(lambda: (parent / "chmod").chmod(0o640)),
            "unlink": attempt((parent / "unlink").unlink),
            "rename": attempt(lambda: (parent / "rename").rename(parent / "renamed")),
            "link": attempt(
                lambda: os.link(
                    parent / "read", storage / "chat" / (directory + "-alias")
                )
            ),
        }
    for directory in ("products", "chat"):
        leaf = storage / directory / "api-rw-probe"
        results[directory] = attempt(lambda: leaf.write_bytes(b"synthetic-api-rw"))
    original = storage / "products/existing-original.webp"

    def stamp() -> tuple[int, ...]:
        info = original.stat()
        return (
            info.st_dev,
            info.st_ino,
            info.st_uid,
            info.st_gid,
            info.st_mode,
            info.st_size,
            info.st_mtime_ns,
            info.st_ctime_ns,
        )

    before = stamp()
    assert original.read_bytes() == b"synthetic-original-preserved"
    assert stamp() == before
    uploaded = storage / "products/api-upload.webp"
    fd = os.open(uploaded, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    try:
        assert os.write(fd, b"synthetic-api-upload") == len(b"synthetic-api-upload")
    finally:
        os.close(fd)
    assert uploaded.read_bytes() == b"synthetic-api-upload"
    assert stat.S_IMODE(uploaded.stat().st_mode) == 0o640
    try:
        collision = os.open(uploaded, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    except OSError as error:
        assert error.errno == errno.EEXIST
    else:
        os.close(collision)
        raise AssertionError("exclusive upload clobbered a file")
    rollback = uploaded.with_name("rollback.webp")
    rollback.write_bytes(b"synthetic-rollback")
    rollback.unlink()
    assert not rollback.exists()
    hero = uploaded.parent / "hero"
    hero.mkdir()
    (hero / "hero-upload.webp").write_bytes(b"synthetic-hero-upload")
    assert (hero / "hero-upload.webp").read_bytes() == b"synthetic-hero-upload"
    assert (
        original.read_bytes() == b"synthetic-original-preserved" and stamp() == before
    )
    results["originals"] = {
        "existingPreserved": True,
        "uploadRead": True,
        "exclusiveCreate": True,
        "rollbackUnlink": True,
        "nestedUpload": True,
        "mode": "0640",
    }
    results["storageParentWrite"] = attempt(
        lambda: (storage / "unexpected-root").mkdir()
    )
    pid = config["workerPid"]
    assert type(pid) is int and pid > 64
    results["procRoot"] = attempt(lambda: os.readlink(f"/proc/{pid}/root"))
    results["procAlias"] = attempt(
        lambda: Path(f"/proc/{pid}/root/storage/.product-image-state/read").read_bytes()
    )
    results["signal"] = attempt(lambda: os.kill(pid, 0))
    libc = ctypes.CDLL(None, use_errno=True)
    ctypes.set_errno(0)
    traced = libc.ptrace(
        0x4206, pid, None, None
    )  # PTRACE_SEIZE; no writes or interrupt.
    if traced == -1:
        assert ctypes.get_errno() in (errno.EPERM, errno.ESRCH)
    results["ptrace"] = {
        "allowed": traced == 0,
        "errno": ctypes.get_errno() if traced else 0,
    }
    # A successful seize is recorded as a baseline finding; exit detaches the tracer.
    results["control"] = attempt(lambda: (root / "control/secret").read_bytes())
    results["runtime"] = attempt(lambda: list((root / "runtime").iterdir()))
    results["identity"] = identity()
    return results


if __name__ == "__main__":
    assert sys.platform == "linux" and len(sys.argv) in (2, 3)
    mode = sys.argv[1]
    if mode in ("caps", "boundary"):
        assert len(sys.argv) == 2
        print(
            "SECURITY_WORKER=" + json.dumps(supervisor(mode), sort_keys=True),
            flush=True,
        )
    elif mode in ("caps-worker", "boundary-worker"):
        assert len(sys.argv) == 2
        print(
            "SECURITY_WORKER_CONTEXT="
            + json.dumps(
                {
                    "pid": os.getpid(),
                    "ppid": os.getppid(),
                    "procSelf": os.readlink("/proc/self"),
                    "identity": identity(),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
            flush=True,
        )
        print(json.dumps(worker(mode), sort_keys=True), flush=True)
    else:
        assert mode == "api" and len(sys.argv) == 3
        print(
            "SECURITY_API=" + json.dumps(api(Path(sys.argv[2])), sort_keys=True),
            flush=True,
        )
