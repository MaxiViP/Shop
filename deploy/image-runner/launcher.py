"""Linux-only sandbox inspector. Never invokes apply or removes an unknown lock.

The systemd manager retains a duplicate deployment flock until separate recovery.
No caller-selected executable, roots, limits, environment attestation or apply mode.
"""

from __future__ import annotations

import array
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import select
import signal
import socket
import stat
import subprocess
import sys
import time
from dataclasses import dataclass

sys.path.insert(0, str(Path(__file__).resolve().parent))

UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
SOURCE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp\Z"
)
SHA = re.compile(r"[0-9a-f]{64}\Z")
STORAGE = Path("/storage")
INPUT = Path("/input")
CGROUP = Path("/sys/fs/cgroup")
FENCE = Path("/control/deploy.lock")
MAX_MEMORY = 768 * 1024**2
HIGH_MEMORY = 512 * 1024**2
STOPPING = False
MANAGER = None  # Fixed broker transport, initialized only from a root-owned request.


def stop_requested(_signal: int, _frame: object) -> None:
    global STOPPING
    STOPPING = True


class Refused(Exception):
    """A bounded diagnostic code; never include raw environment or lock contents."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise Refused(code)


def text(path: Path, limit: int = 65536) -> str:
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    require(len(data) <= limit, "INPUT_LIMIT")
    return data.decode("utf-8", errors="strict")


def strict_json(value: str) -> dict[str, object]:
    def constant(_value: str) -> None:
        raise Refused("INVALID_JSON")

    def pairs(items: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in items:
            require(key not in result, "DUPLICATE_KEY")
            result[key] = item
        return result

    result = json.loads(value, object_pairs_hook=pairs, parse_constant=constant)
    require(isinstance(result, dict), "INVALID_REQUEST")
    return result


def request(value: str, instance: str) -> dict[str, object]:
    data = strict_json(value)
    require(
        set(data) - {"managerBroker"}
        == {
            "schemaVersion",
            "kind",
            "runId",
            "batchSize",
            "inventorySha256",
            "approvalSha256",
            "launcherSha256",
            "unitSha256",
            "pinSha256",
        },
        "INVALID_REQUEST",
    )
    require(
        type(data["schemaVersion"]) is int and data["schemaVersion"] == 1,
        "INVALID_REQUEST",
    )
    require(
        data["kind"] == "image-sandbox-inspection" and data["runId"] == instance,
        "SCOPE_MISMATCH",
    )
    require(
        type(data["batchSize"]) is int and data["batchSize"] in (1, 5, 20, 50),
        "INVALID_BATCH",
    )
    for key in (
        "inventorySha256",
        "approvalSha256",
        "launcherSha256",
        "unitSha256",
        "pinSha256",
    ):
        require(
            isinstance(data[key], str) and SHA.fullmatch(str(data[key])) is not None,
            "INVALID_DIGEST",
        )
    if "managerBroker" in data:
        from broker import Denied, identity

        try:
            identity(data["managerBroker"])
        except Denied:
            raise Refused("INVALID_REQUEST") from None
    return data


def approval_scope(value: str, data: dict[str, object]) -> None:
    approved = strict_json(value)
    require(
        type(approved.get("batchSize")) is int
        and approved.get("runId") == data["runId"]
        and approved.get("batchSize") == data["batchSize"],
        "SCOPE_MISMATCH",
    )


@dataclass(frozen=True)
class Mount:
    id: int
    device: str
    root: str
    path: str
    options: frozenset[str]
    kind: str
    super_options: frozenset[str]


def mounts(value: str) -> list[Mount]:
    def unescape(part: str) -> str:
        return re.sub(r"\\(040|011|012|134)", lambda match: chr(int(match[1], 8)), part)

    result: list[Mount] = []
    for line in value.splitlines():
        left, right = line.split(" - ", 1)
        fields, extra = left.split(), right.split()
        require(len(fields) >= 6 and len(extra) >= 3, "MOUNT_UNVERIFIED")
        result.append(
            Mount(
                int(fields[0]),
                fields[2],
                unescape(fields[3]),
                unescape(fields[4]),
                frozenset(fields[5].split(",")),
                extra[0],
                frozenset(extra[2].split(",")),
            )
        )
    require(0 < len(result) <= 4096, "MOUNT_UNVERIFIED")
    require(len({item.path for item in result}) == len(result), "STACKED_MOUNT")
    return result


def beneath(path: str, parent: str) -> bool:
    return PurePosixPath(path).is_relative_to(parent)


def mount_at(items: list[Mount], path: str) -> Mount:
    matches = [item for item in items if beneath(path, item.path)]
    require(bool(matches), "MOUNT_UNVERIFIED")
    return max(matches, key=lambda item: len(PurePosixPath(item.path).parts))


def mount_policy(items: list[Mount]) -> dict[str, object]:
    root = mount_at(items, "/")
    storage = mount_at(items, "/storage")
    source = mount_at(items, "/storage/products")
    require("ro" in root.options, "ROOT_NOT_READONLY")
    require(storage.path == "/storage" and "rw" in storage.options, "MOUNT_UNVERIFIED")
    require(
        source.path == "/storage/products" and "ro" in source.options,
        "ORIGINALS_NOT_READONLY",
    )
    for path in ("/storage/product-variants", "/storage/.product-image-state/work"):
        require(mount_at(items, path).id == storage.id, "LINK_MOUNT_MISMATCH")
    for path in (
        "/input/request.json",
        "/input/inventory.jsonl",
        "/input/approval.json",
    ):
        require("ro" in mount_at(items, path).options, "INPUT_NOT_READONLY")
    for item in items:
        if item.kind == "proc":
            kernel_tree = any(
                beneath(item.path, path)
                for path in (
                    "/proc/sys",
                    "/proc/irq",
                    "/proc/bus",
                    "/proc/fs",
                    "/proc/acpi",
                    "/proc/asound",
                    "/proc/scsi",
                )
            ) or item.path in (
                "/proc/sysrq-trigger",
                "/proc/apm",
                "/proc/mtrr",
                "/proc/latency_stats",
                "/proc/timer_stats",
            )
            require(
                (item.path == "/proc" and item.root == "/")
                or (
                    kernel_tree
                    and item.root == item.path[len("/proc") :]
                    and "ro" in item.options
                ),
                "FOREIGN_PROC_MOUNT",
            )
        if item.kind == "sysfs":
            require("ro" in item.options, "SYSFS_WRITABLE")
        require(
            not (beneath(item.path, source.path) and "rw" in item.options),
            "WRITABLE_ALIAS",
        )
        if item.device == source.device and "rw" in item.options:
            require(item.id == storage.id, "WRITABLE_ALIAS")
        if "rw" in item.options:
            allowed = (
                item.id == storage.id
                or (item.kind == "proc" and item.path == "/proc")
                or (item.kind == "devpts" and beneath(item.path, "/dev"))
                or (
                    item.kind == "tmpfs"
                    and any(beneath(item.path, p) for p in ("/tmp", "/run", "/dev"))
                )
            )
            require(allowed, "UNEXPECTED_WRITABLE_MOUNT")
        if item.kind == "cgroup2":
            require("ro" in item.options, "CGROUP_WRITABLE")
    require(mount_at(items, "/sys/fs/cgroup").kind == "cgroup2", "CGROUP_V2_REQUIRED")
    for path, maximum in (("/tmp", 64 * 1024**2), ("/run", 8 * 1024**2)):
        item = mount_at(items, path)
        require(item.path == path and item.kind == "tmpfs", "TEMP_UNBOUNDED")
        sizes = [
            option[5:] for option in item.super_options if option.startswith("size=")
        ]
        require(len(sizes) == 1 and size_bytes(sizes[0]) <= maximum, "TEMP_UNBOUNDED")
    return {"sourceMount": source.id, "writableMount": storage.id, "aliases": "checked"}


def size_bytes(value: str) -> int:
    match = re.fullmatch(r"([1-9][0-9]*)([kKmMgG]?)", value)
    require(match is not None, "TEMP_UNBOUNDED")
    assert match is not None
    return int(match[1]) * 1024 ** (
        "kmgt".find(match[2].lower()) + 1 if match[2] else 0
    )


def cgroup_path(value: str) -> str:
    lines = value.splitlines()
    require(len(lines) == 1 and lines[0].startswith("0::/"), "CGROUP_V2_REQUIRED")
    path = lines[0][3:]
    require(
        path != "/" and not any(part in (".", "..") for part in path.split("/")),
        "CGROUP_UNVERIFIED",
    )
    return path


def cgroup_policy(values: dict[str, str]) -> dict[str, object]:
    expected = {
        "memory.max": str(MAX_MEMORY),
        "memory.high": str(HIGH_MEMORY),
        "memory.swap.max": "0",
        "memory.oom.group": "1",
        "pids.max": "64",
        "cgroup.type": "domain",
    }
    require(
        all(values.get(key, "").strip() == value for key, value in expected.items()),
        "CGROUP_LIMITS_UNVERIFIED",
    )
    cpu = values.get("cpu.max", "").split()
    require(
        len(cpu) == 2 and all(item.isdigit() for item in cpu), "CPU_LIMIT_UNVERIFIED"
    )
    require(
        int(cpu[0]) > 0 and int(cpu[1]) > 0 and int(cpu[0]) * 2 <= int(cpu[1]),
        "CPU_LIMIT_UNVERIFIED",
    )
    return {key: value.strip() for key, value in values.items()}


def process_policy(value: str) -> None:
    fields = dict(line.split(":", 1) for line in value.splitlines() if ":" in line)
    allowed_caps = (1 << 2) | (1 << 5) | (1 << 6) | (1 << 7)
    require(fields.get("NoNewPrivs", "").strip() == "1", "PROCESS_POLICY_UNVERIFIED")
    # An allowlist alone accepted 0x64: systemd had removed the CAP_SETUID that
    # the fixed worker transition needs. Refuse before acquiring the fence.
    for key in ("CapEff", "CapPrm", "CapBnd"):
        require(
            int(fields.get(key, "-1").strip(), 16) == allowed_caps,
            "PROCESS_POLICY_UNVERIFIED",
        )
    for key in ("CapInh", "CapAmb"):
        require(
            int(fields.get(key, "-1").strip(), 16) == 0, "PROCESS_POLICY_UNVERIFIED"
        )
    require(fields.get("Seccomp", "").strip() == "2", "PROCESS_POLICY_UNVERIFIED")


def show(unit: str) -> dict[str, str]:
    require(not STOPPING, "STOP_REQUESTED")
    if MANAGER is not None:
        from broker import Denied

        try:
            return MANAGER.show(unit)
        except (Denied, OSError, ValueError, KeyError):
            raise Refused("MANAGER_UNVERIFIED") from None
    result = subprocess.run(
        ["/usr/bin/systemctl", "show", "--all", "--no-pager", unit],
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=3,
        check=False,
    )
    require(
        result.returncode == 0 and len(result.stdout) <= 65536, "MANAGER_UNVERIFIED"
    )
    return dict(
        line.split("=", 1)
        for line in result.stdout.decode().splitlines()
        if "=" in line
    )


def manager_policy(
    values: dict[str, str], pin: dict[str, str], unit: str, group: str
) -> None:
    expected = {
        "LoadState": "loaded",
        "Type": "exec",
        "User": "",
        "Group": "root",
        "Restart": "no",
        "Delegate": "no",
        "KillMode": "control-group",
        "OOMPolicy": "kill",
        "SendSIGKILL": "yes",
        "RuntimeMaxUSec": "10min",
        "TimeoutStopUSec": "30s",
        "ControlGroup": group,
        "PrivatePIDs": "yes",
        "PrivateUsers": "yes",
        "PrivateUsersEx": "full",
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
    require(
        all(values.get(key) == value for key, value in expected.items()),
        "MANAGER_POLICY_UNVERIFIED",
    )
    require(
        pin.get("ActiveState") == "active"
        and pin.get("RefuseManualStop") == "yes"
        and pin.get("DropInPaths") == ""
        and pin.get("NeedDaemonReload") == "no"
        and pin.get("FragmentPath")
        == "/etc/systemd/system/shop-image-runner-pin@.target"
        and unit in pin.get("Wants", "").split(),
        "FENCE_PIN_UNVERIFIED",
    )


def environment_policy(names: set[str]) -> None:
    allowed = {
        "PATH",
        "LANG",
        "LC_ALL",
        "TSX_DISABLE_CACHE",
        "INVOCATION_ID",
        "JOURNAL_STREAM",
        "NOTIFY_SOCKET",
        "FDSTORE",
        "LISTEN_FDS",
        "LISTEN_PID",
        "LISTEN_FDNAMES",
        "SYSTEMD_EXEC_PID",
        "MEMORY_PRESSURE_WATCH",
        "MEMORY_PRESSURE_WRITE",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
    }
    require(names <= allowed, "SECRET_ENV_REFUSED")


def regular(path: Path, maximum: int, owner: int | None = None) -> os.stat_result:
    require(path.resolve(strict=True) == path, "UNSAFE_PATH")
    info = path.lstat()
    require(
        stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= maximum,
        "UNSAFE_FILE",
    )
    require(
        info.st_mode & 0o022 == 0 and (owner is None or info.st_uid == owner),
        "UNSAFE_FILE",
    )
    return info


def digest(path: Path, maximum: int, expected: object) -> None:
    info = regular(path, maximum)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(path, flags)
    try:
        opened = os.fstat(fd)
        require(
            (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns),
            "INPUT_CHANGED",
        )
        hasher = hashlib.sha256()
        with os.fdopen(os.dup(fd), "rb") as handle:
            remaining = maximum + 1
            while remaining:
                data = handle.read(min(remaining, 65536))
                if not data:
                    break
                hasher.update(data)
                remaining -= len(data)
        after = path.lstat()
        require(
            remaining > 0
            and (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns),
            "INPUT_CHANGED",
        )
        require(hasher.hexdigest() == expected, "DIGEST_MISMATCH")
    finally:
        os.close(fd)


def storage_policy(uid: int, gid: int) -> None:
    parent = STORAGE.lstat()
    require(parent.st_uid == 0 and parent.st_mode & 0o022 == 0, "STORAGE_PARENT_UNSAFE")
    require(STORAGE.resolve() == STORAGE, "UNSAFE_PATH")
    # No ambient siblings, directory aliases or writable ACL on the common mount.
    require(
        set(os.listdir(STORAGE))
        <= {"products", "product-variants", ".product-image-state", "chat"},
        "UNKNOWN_STORAGE_ENTRY",
    )
    require(not os.listxattr(STORAGE), "STORAGE_ACL_UNVERIFIED")
    for name in ("product-variants", ".product-image-state"):
        path = STORAGE / name
        info = path.lstat()
        require(
            path.resolve() == path
            and stat.S_ISDIR(info.st_mode)
            and info.st_uid == uid
            and info.st_gid == gid
            and info.st_mode & 0o077 == 0,
            "PRIVATE_ROOT_UNSAFE",
        )
        require(not os.listxattr(path), "STORAGE_ACL_UNVERIFIED")
    count = 0
    with os.scandir(STORAGE / "products") as entries:
        for entry in entries:
            count += 1
            require(count <= 100000, "SOURCE_SCAN_LIMIT")
            require(SOURCE.fullmatch(entry.name) is not None, "SOURCE_ALIAS_UNVERIFIED")
            info = entry.stat(follow_symlinks=False)
            require(
                stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                "SOURCE_ALIAS_UNVERIFIED",
            )


def acquire_fence(path: Path) -> int:
    import fcntl  # Linux only; importing this module remains safe on Windows.

    before = regular(path, 4096, owner=0)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require(
            (opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino),
            "FENCE_CHANGED",
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused("FENCE_BUSY") from error
        require(
            (path.lstat().st_dev, path.lstat().st_ino)
            == (opened.st_dev, opened.st_ino),
            "FENCE_CHANGED",
        )
        return fd
    except BaseException:
        os.close(fd)
        raise


def notify_store(fd: int, address: str) -> None:
    # RootDirectory uses the manager's automatically bound /run/host socket.
    # No caller-selected socket or prefix lookalike can acknowledge admission.
    require(address in ("/run/systemd/notify", "/run/host/notify"), "NOTIFY_UNVERIFIED")
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
        channel.connect(address)
        channel.sendmsg(
            [b"FDSTORE=1\nFDNAME=deploy-fence\nFDPOLL=0"],
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))],
        )
        read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
        try:
            channel.sendmsg(
                [b"BARRIER=1"],
                [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [write_fd]))],
            )
            os.close(write_fd)
            write_fd = -1
            require(
                bool(select.select([read_fd], [], [], 3)[0])
                and os.read(read_fd, 1) == b"",
                "FDSTORE_UNVERIFIED",
            )
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)


def unknown_locks(root: Path, limit: int = 1000) -> int:
    """Read-only count. No owner inference, PID lookup, stale timeout or unlink."""
    count = 0
    for parent in (root / "locks", root / "runs", root / "production-runs"):
        if not os.path.lexists(parent):
            continue
        require(parent.resolve() == parent and parent.is_dir(), "UNSAFE_PATH")
        with os.scandir(parent) as entries:
            for entry in entries:
                count += 1
                require(count <= limit, "LOCK_SCAN_LIMIT")
                info = entry.stat(follow_symlinks=False)
                require(not stat.S_ISLNK(info.st_mode), "UNSAFE_PATH")
                if entry.name.endswith(".lock"):
                    raise Refused("BUSY")
                if stat.S_ISDIR(info.st_mode):
                    lock = Path(entry.path) / "run.lock"
                    require(not os.path.lexists(lock), "BUSY")
    return count


def pid_namespace(pid: int, proc_self: str) -> None:
    # PID=1 alone does not prove that /proc was mounted for this PID namespace.
    require(pid == 1 and proc_self == "1", "PID_NAMESPACE_UNVERIFIED")


def inspect(instance: str) -> None:
    global MANAGER
    require(sys.platform == "linux", "LINUX_REQUIRED")
    require(UUID.fullmatch(instance) is not None, "INVALID_INSTANCE")
    require(os.geteuid() == 0 and os.getpid() == 1, "PID_NAMESPACE_UNVERIFIED")
    pid_namespace(os.getpid(), os.readlink("/proc/self"))
    signal.signal(signal.SIGTERM, stop_requested)
    process_policy(text(Path("/proc/self/status")))
    require(
        not os.environ.get("LISTEN_FDS"), "FENCE_BUSY"
    )  # Never adopt a retained fence.
    environment_policy(set(os.environ))
    for parent in (Path("/artifact"), Path("/artifact/apps/api")):
        require(
            not any(item.name.startswith(".env") for item in parent.iterdir()),
            "SECRET_ARTIFACT_REFUSED",
        )
    regular(INPUT / "request.json", 8192, owner=0)
    data = request(text(INPUT / "request.json", 8192), instance)
    if "managerBroker" in data:
        from broker import Client

        require(
            stat.S_IMODE((INPUT / "request.json").stat().st_mode) == 0o600,
            "BROKER_BINDING_UNSAFE",
        )
        MANAGER = Client(
            instance,
            data["managerBroker"],
            hashlib.sha256((INPUT / "request.json").read_bytes()).hexdigest(),
        )
    else:
        manager_socket = Path("/run/systemd/private").lstat()
        require(
            stat.S_ISSOCK(manager_socket.st_mode)
            and manager_socket.st_uid == 0
            and manager_socket.st_mode & 0o077 == 0,
            "MANAGER_SOCKET_UNSAFE",
        )
    for path, maximum, key in (
        (INPUT / "inventory.jsonl", 32 * 1024**2, "inventorySha256"),
        (INPUT / "approval.json", 256 * 1024, "approvalSha256"),
        (Path(__file__).resolve(), 1024 * 1024, "launcherSha256"),
        (Path("/control/runner.service"), 65536, "unitSha256"),
        (Path("/control/pin.target"), 65536, "pinSha256"),
    ):
        digest(path, maximum, data[key])
    approval_scope(text(INPUT / "approval.json", 256 * 1024), data)
    items = mounts(text(Path("/proc/self/mountinfo"), 1024 * 1024))
    mount_report = mount_policy(items)
    group = cgroup_path(text(Path("/proc/self/cgroup")))
    location = CGROUP / group.lstrip("/")
    require(
        location.resolve() == location and beneath(str(location), str(CGROUP)),
        "CGROUP_UNVERIFIED",
    )
    values = {
        name: text(location / name, 4096)
        for name in (
            "memory.max",
            "memory.high",
            "memory.swap.max",
            "memory.oom.group",
            "pids.max",
            "cpu.max",
            "cgroup.type",
        )
    }
    limits = cgroup_policy(values)
    unit = f"shop-image-runner@{instance}.service"
    pin_unit = f"shop-image-runner-pin@{instance}.target"
    # Type=exec lets the pin target become active while this inspector starts.
    pin = show(pin_unit)
    deadline = time.monotonic() + 5
    while pin.get("ActiveState") == "activating" and time.monotonic() < deadline:
        time.sleep(0.05)
        pin = show(pin_unit)
    manager_policy(show(unit), pin, unit, group)
    import pwd

    account = pwd.getpwnam("shop")
    require(account.pw_uid == 997 and account.pw_gid > 0, "SHOP_IDENTITY_UNVERIFIED")
    storage_policy(account.pw_uid, account.pw_gid)
    unknown_locks(STORAGE / ".product-image-state")
    require(not STOPPING, "STOP_REQUESTED")
    fence = acquire_fence(FENCE)
    # Never LOCK_UN: the manager's duplicate must survive this process and all its children.
    try:
        notify_store(fence, os.environ.get("NOTIFY_SOCKET", ""))
        require(show(unit).get("NFileDescriptorStore") == "1", "FDSTORE_UNVERIFIED")
        require(not STOPPING, "STOP_REQUESTED")
        child = subprocess.Popen(
            [
                "/usr/bin/node",
                "--import",
                "tsx",
                "data/product-image-production/run.ts",
                "--dry-run",
                "--inventory",
                "/input/inventory.jsonl",
                "--source-root",
                "/storage/products",
                "--variants-root",
                "/storage/product-variants",
                "--state-root",
                "/storage/.product-image-state",
                "--batch-size",
                str(data["batchSize"]),
                "--approval",
                "/input/approval.json",
                "--approval-sha256",
                str(data["approvalSha256"]),
            ],
            cwd="/artifact/apps/api",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            close_fds=True,
            user=account.pw_uid,
            group=account.pw_gid,
            extra_groups=[],
            env={
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "NODE_ENV": "production",
                "TSX_DISABLE_CACHE": "1",
                "TMPDIR": "/tmp",
                "UV_THREADPOOL_SIZE": "1",
            },
        )
        if STOPPING:
            child.terminate()
        _, error = child.communicate(timeout=45)
        require(not STOPPING, "STOP_REQUESTED")
        require(child.returncode == 0, "SCOPE_OR_STATE_UNVERIFIED")
        require(not error, "CHILD_DIAGNOSTIC_UNVERIFIED")
        # No native publication probe or production apply is authorized by inspection.
        print(
            json.dumps(
                {
                    "error": "SANDBOX_UNVERIFIED",
                    "runId": instance,
                    "inventorySha256": data["inventorySha256"],
                    "approvalSha256": data["approvalSha256"],
                    "inspection": "passed",
                    "mounts": mount_report,
                    "limits": limits,
                    "nativeLinkInUnit": "NOT VERIFIED",
                    "productionApplyBlocked": True,
                    "apiWriteIsolation": "NOT VERIFIED",
                    "rebootRecovery": "NOT VERIFIED",
                    "fence": "retained by systemd; separate quiescence review required",
                }
            ),
            flush=True,
        )
    finally:
        os.close(
            fence
        )  # close local reference only; no FDSTOREREMOVE and no lock-file mutation.


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2, "INVALID_OPTIONS")
        inspect(sys.argv[1])
    except (
        Refused,
        OSError,
        ValueError,
        KeyError,
        subprocess.SubprocessError,
    ) as error:
        print(
            json.dumps(
                {
                    "error": "SANDBOX_UNVERIFIED",
                    "reason": str(error)
                    if isinstance(error, Refused)
                    else "INSPECTION_FAILED",
                    "productionApplyBlocked": True,
                }
            ),
            flush=True,
        )
    # Even a fully successful inspection is not an attestation authorizing apply.
    sys.exit(78)
