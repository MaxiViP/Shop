"""Fixed read-only manager channel. Local disposable VM candidate only."""

from __future__ import annotations

import array
import hashlib
import json
import os
from pathlib import Path
import re
import select
import socket
import stat
import struct
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))

UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
SHA = re.compile(r"[0-9a-f]{64}\Z")
SO_PEERPIDFD = 77  # Linux UAPI; mandatory, no credential-only fallback.
ENDPOINT = Path("/run/image-manager.sock")
FIELDS = (
    "Id",
    "LoadState",
    "ActiveState",
    "MainPID",
    "Type",
    "User",
    "Group",
    "Restart",
    "Delegate",
    "KillMode",
    "OOMPolicy",
    "SendSIGKILL",
    "RuntimeMaxUSec",
    "TimeoutStopUSec",
    "ControlGroup",
    "PrivatePIDs",
    "PrivateUsers",
    "PrivateUsersEx",
    "PrivateMounts",
    "NoNewPrivileges",
    "FileDescriptorStoreMax",
    "FileDescriptorStorePreserve",
    "NFileDescriptorStore",
    "NotifyAccess",
    "DropInPaths",
    "NeedDaemonReload",
    "Transient",
    "FragmentPath",
    "RefuseManualStop",
    "Wants",
)


class Denied(Exception):
    pass


def require(ok: object, reason: str) -> None:
    if not ok:
        raise Denied(reason)


def strict(value: bytes) -> dict[str, object]:
    def pairs(items: list[tuple[str, object]]) -> dict[str, object]:
        result = {}
        for key, item in items:
            require(key not in result, "DUPLICATE_KEY")
            result[key] = item
        return result

    data = json.loads(value, object_pairs_hook=pairs)
    require(type(data) is dict, "INVALID_MESSAGE")
    return data


def names(instance: str) -> tuple[str, str]:
    require(UUID.fullmatch(instance), "INVALID_INSTANCE")
    return (
        f"shop-image-runner@{instance}.service",
        f"shop-image-runner-pin@{instance}.target",
    )


def identity(config: object) -> dict[str, int]:
    require(
        type(config) is dict
        and set(config) == {"pidfdDev", "pidfdIno", "socketDev", "socketIno"},
        "INVALID_BROKER_IDENTITY",
    )
    require(
        all(type(value) is int and 0 < value < 2**64 for value in config.values()),
        "INVALID_BROKER_IDENTITY",
    )
    return config


def fd_identity(fd: int) -> tuple[int, int]:
    info = os.fstat(fd)
    return info.st_dev, info.st_ino


def live(fd: int) -> bool:
    return not select.select([fd], [], [], 0)[0]


def peer(channel: socket.socket) -> tuple[tuple[int, int, int], int]:
    credentials = struct.unpack(
        "3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )
    fd = channel.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD)
    os.set_inheritable(fd, False)
    return credentials, fd


def receive(channel: socket.socket, maximum: int) -> tuple[bytes, tuple[int, int, int]]:
    data, controls, flags, _ = channel.recvmsg(
        maximum + 1,
        socket.CMSG_SPACE(12) + socket.CMSG_SPACE(64),
        socket.MSG_CMSG_CLOEXEC,
    )
    credentials = []
    unexpected = False
    for level, kind, value in controls:
        if (
            level == socket.SOL_SOCKET
            and kind == socket.SCM_CREDENTIALS
            and len(value) == 12
        ):
            credentials.append(struct.unpack("3i", value))
        else:
            unexpected = True
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                descriptors = array.array("i")
                descriptors.frombytes(
                    value[: len(value) - len(value) % descriptors.itemsize]
                )
                for fd in descriptors:
                    os.close(fd)
    require(
        not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) and 0 < len(data) <= maximum,
        "MESSAGE_LIMIT",
    )
    require(not unexpected and len(credentials) == 1, "MESSAGE_CREDENTIALS_UNVERIFIED")
    return data, credentials[0]


def message(instance: str, digest: str) -> dict[str, object]:
    return {
        "version": 1,
        "operation": "snapshot",
        "instance": instance,
        "requestSha256": digest,
        "nonce": os.urandom(16).hex(),
    }


class Client:
    def __init__(self, instance: str, config: object, digest: str) -> None:
        self.units = names(instance)
        self.instance, self.config, self.digest = instance, identity(config), digest
        require(SHA.fullmatch(digest), "INVALID_BINDING")

    def connect(self) -> socket.socket:
        info = ENDPOINT.lstat()
        require(
            ENDPOINT.resolve(strict=True) == ENDPOINT
            and stat.S_ISSOCK(info.st_mode)
            and info.st_uid == info.st_gid == 0
            and stat.S_IMODE(info.st_mode) == 0o600
            and (info.st_dev, info.st_ino)
            == (self.config["socketDev"], self.config["socketIno"]),
            "BROKER_ENDPOINT_UNVERIFIED",
        )
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        try:
            channel.settimeout(3)
            channel.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            channel.connect(str(ENDPOINT))
            credentials, fd = peer(channel)
            try:
                own = os.pidfd_open(os.getpid())
                try:
                    require(fd_identity(own) != fd_identity(fd), "PIDFS_REQUIRED")
                finally:
                    os.close(own)
                require(
                    credentials[1:] == (0, 0)
                    and live(fd)
                    and fd_identity(fd)
                    == (self.config["pidfdDev"], self.config["pidfdIno"]),
                    "BROKER_PEER_UNVERIFIED",
                )
            finally:
                os.close(fd)
            after = ENDPOINT.lstat()
            require(
                (after.st_dev, after.st_ino) == (info.st_dev, info.st_ino),
                "BROKER_ENDPOINT_CHANGED",
            )
            return channel
        except BaseException:
            channel.close()
            raise

    def show(self, unit: str) -> dict[str, str]:
        require(unit in self.units, "UNIT_REFUSED")
        query = message(self.instance, self.digest)
        with self.connect() as channel:
            channel.sendall(json.dumps(query).encode())
            raw, credentials = receive(channel, 65536)
            require(credentials[1:] == (0, 0), "BROKER_PEER_UNVERIFIED")
        response = strict(raw)
        require(
            set(response) == {"version", "nonce", "requestSha256", "units"}
            and type(response["version"]) is int
            and response["version"] == 1
            and response["nonce"] == query["nonce"]
            and response["requestSha256"] == self.digest,
            "BROKER_REPLY_UNVERIFIED",
        )
        units = response["units"]
        require(
            type(units) is dict and set(units) == set(self.units),
            "BROKER_REPLY_UNVERIFIED",
        )
        for values in units.values():
            require(
                type(values) is dict
                and set(values) <= set(FIELDS)
                and all(type(value) is str for value in values.values()),
                "BROKER_REPLY_UNVERIFIED",
            )
        return units[unit]


def validate(
    data: dict[str, object], instance: str, binding: dict[str, object]
) -> None:
    require(
        set(data) == {"version", "operation", "instance", "requestSha256", "nonce"}
        and type(data["version"]) is int
        and data["version"] == 1
        and data["operation"] == "snapshot"
        and data["instance"] == instance
        and data["requestSha256"] == binding["requestSha256"]
        and type(data["nonce"]) is str
        and re.fullmatch("[0-9a-f]{32}", data["nonce"]),
        "REQUEST_REFUSED",
    )


def caller(credentials: tuple[int, int, int], fd: int, unit: str) -> str:
    pid, uid, gid = credentials
    require(pid > 1 and uid == gid == 0 and live(fd), "CALLER_REFUSED")
    other = os.pidfd_open(pid)
    try:
        require(fd_identity(other) == fd_identity(fd), "CALLER_CHANGED")
    finally:
        os.close(other)
    status = dict(
        line.split(":", 1)
        for line in Path(f"/proc/{pid}/status").read_text().splitlines()
        if ":" in line
    )
    require(
        status["Uid"].split() == status["Gid"].split() == ["0"] * 4
        and len(status["NSpid"].split()) >= 2
        and status["NSpid"].split()[-1] == "1",
        "CALLER_REFUSED",
    )
    import launcher

    launcher.process_policy(Path(f"/proc/{pid}/status").read_text())
    group = launcher.cgroup_path(Path(f"/proc/{pid}/cgroup").read_text())
    require(
        group.startswith("/system.slice/") and group.endswith("/" + unit),
        "CALLER_REFUSED",
    )
    require(live(fd), "CALLER_CHANGED")
    return group


def snapshot(units: tuple[str, str]) -> dict[str, dict[str, str]]:
    result = subprocess.run(
        [
            "/usr/bin/systemctl",
            "show",
            "--all",
            "--no-pager",
            "--property=" + ",".join(FIELDS),
            "--",
            *units,
        ],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=2,
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
        check=False,
    )
    require(
        result.returncode == 0 and len(result.stdout) <= 65536 and not result.stderr,
        "MANAGER_UNVERIFIED",
    )
    output = {}
    for block in result.stdout.decode().strip().split("\n\n"):
        values = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        require(
            values.get("Id") in units
            and values["Id"] not in output
            and set(values) <= set(FIELDS),
            "MANAGER_UNVERIFIED",
        )
        output[values["Id"]] = values
    require(set(output) == set(units), "MANAGER_UNVERIFIED")
    return output


def binding_file(instance: str) -> Path:
    names(instance)
    return Path("/run/korzina-manager-broker") / instance / "binding.json"


def serve(instance: str) -> None:
    require(
        sys.platform == "linux"
        and os.geteuid() == 0
        and Path("/etc/image-acceptance-disposable").read_text()
        == "isolated-image-fixtures-v1\n",
        "DISPOSABLE_VM_REQUIRED",
    )
    units = names(instance)
    config = binding_file(instance)
    directory = config.parent
    info = directory.lstat()
    require(
        directory.resolve() == directory
        and info.st_uid == info.st_gid == 0
        and stat.S_IMODE(info.st_mode) == 0o700,
        "BINDING_UNSAFE",
    )
    os.umask(0o177)
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        server.bind(str(directory / "manager.sock"))
        server.listen(4)
        server.settimeout(1)
        print(
            "BROKER_READY=" + json.dumps({"instance": instance, "pid": os.getpid()}),
            flush=True,
        )
        deadline, count = time.monotonic() + 300, 0
        while time.monotonic() < deadline and count < 64:
            try:
                channel, _ = server.accept()
            except TimeoutError:
                continue
            count += 1
            fd = -1
            try:
                with channel:
                    channel.settimeout(2)
                    credentials, fd = peer(channel)
                    raw, sender = receive(channel, 4096)
                    require(sender == credentials, "MESSAGE_CALLER_MISMATCH")
                    info = config.lstat()
                    require(
                        config.resolve() == config
                        and stat.S_ISREG(info.st_mode)
                        and info.st_uid == info.st_gid == 0
                        and stat.S_IMODE(info.st_mode) == 0o600
                        and info.st_size <= 4096,
                        "BINDING_UNSAFE",
                    )
                    binding = strict(config.read_bytes())
                    require(
                        set(binding) == {"requestSha256", "unitSha256", "pinSha256"},
                        "BINDING_UNSAFE",
                    )
                    query = strict(raw)
                    validate(query, instance, binding)
                    group = caller(credentials, fd, units[0])
                    for path, key in (
                        ("shop-image-runner@.service", "unitSha256"),
                        ("shop-image-runner-pin@.target", "pinSha256"),
                    ):
                        require(
                            hashlib.sha256(
                                (Path("/etc/systemd/system") / path).read_bytes()
                            ).hexdigest()
                            == binding[key],
                            "UNIT_CHANGED",
                        )
                    values = snapshot(units)
                    require(
                        values[units[0]].get("MainPID") == str(credentials[0])
                        and values[units[0]].get("ControlGroup") == group,
                        "CALLER_REFUSED",
                    )
                    require(
                        caller(credentials, fd, units[0]) == group, "CALLER_CHANGED"
                    )
                    channel.sendall(
                        json.dumps(
                            {
                                "version": 1,
                                "nonce": query["nonce"],
                                "requestSha256": binding["requestSha256"],
                                "units": values,
                            }
                        ).encode()
                    )
                    print(
                        "BROKER_AUDIT="
                        + json.dumps(
                            {
                                "decision": "ALLOWED",
                                "pid": credentials[0],
                                "uid": 0,
                                "cgroup": group,
                            }
                        ),
                        flush=True,
                    )
            except (
                Denied,
                OSError,
                ValueError,
                KeyError,
                subprocess.SubprocessError,
            ) as error:
                # No request payload, environment, command line or secret values in logs.
                print(
                    "BROKER_AUDIT="
                    + json.dumps(
                        {
                            "decision": "DENIED",
                            "reason": str(error)
                            if isinstance(error, Denied)
                            else type(error).__name__,
                        }
                    ),
                    flush=True,
                )
            finally:
                if fd >= 0:
                    os.close(fd)


if __name__ == "__main__":
    require(len(sys.argv) == 2, "INVALID_OPTIONS")
    serve(sys.argv[1])
