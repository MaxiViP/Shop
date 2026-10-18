"""Read-only target metadata audit. No image bytes, env, DB, probes or changes."""

import json
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import sys

ROOTS = (
    "/var/lib/korzinamarket/uploads",
    "/var/lib/korzinamarket/uploads/products",
    "/var/lib/korzinamarket/uploads/product-variants",
    "/var/lib/korzinamarket/uploads/.product-image-state",
    "/var/lib/korzinamarket-image-runner",
)
PROPERTIES = (
    "LoadState",
    "ActiveState",
    "MainPID",
    "User",
    "Group",
    "SupplementaryGroups",
    "FragmentPath",
    "DropInPaths",
    "NeedDaemonReload",
    "PrivatePIDs",
    "PrivateTmp",
    "PrivateUsers",
    "ProtectSystem",
    "ProtectHome",
    "NoNewPrivileges",
    "ReadOnlyPaths",
    "ReadWritePaths",
    "InaccessiblePaths",
    "ControlGroup",
)
SAFE_OPTIONS = {
    "rw",
    "ro",
    "nosuid",
    "nodev",
    "noexec",
    "relatime",
    "noatime",
    "lazytime",
    "nobarrier",
    "barrier=1",
    "errors=remount-ro",
    "data=ordered",
    "discard",
    "usrquota",
    "grpquota",
    "prjquota",
}


def read(path: Path, limit: int = 1024 * 1024) -> str:
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("metadata limit exceeded")
    return data.decode("utf-8", errors="strict")


def command(*args: str) -> str:
    result = subprocess.run(
        list(args),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"},
        timeout=5,
        check=False,
    )
    if result.returncode or len(result.stdout.encode()) > 65536:
        return "UNVERIFIED: command unavailable, refused or output limit"
    return result.stdout.strip()


def metadata(path: str) -> dict[str, object]:
    try:
        info = os.lstat(path)
        result: dict[str, object] = {
            "path": path,
            "uid": info.st_uid,
            "gid": info.st_gid,
            "mode": oct(stat.S_IMODE(info.st_mode)),
            "dev": info.st_dev,
            "ino": info.st_ino,
            "directory": stat.S_ISDIR(info.st_mode),
            "symlink": stat.S_ISLNK(info.st_mode),
        }
        if stat.S_ISLNK(info.st_mode):
            result["target"] = os.readlink(path)
        elif Path(path).resolve() == Path(path):
            result["xattrNames"] = os.listxattr(path, follow_symlinks=False)
            if shutil.which("getfacl"):
                result["acl"] = command("getfacl", "-c", "-n", "-p", "--", path)
            else:
                result["acl"] = "UNVERIFIED: getfacl unavailable"
        return result
    except OSError as error:
        return {"path": path, "errno": error.errno}


def mount_metadata(path: Path) -> list[dict[str, object]]:
    result = []
    for line in read(path).splitlines():
        left, right = line.split(" - ", 1)
        values, tail = left.split(), right.split()
        target = values[4]
        if not any(
            root == target
            or root.startswith(target.rstrip("/") + "/")
            or target.startswith(root + "/")
            for root in ROOTS
        ):
            continue
        options = set(values[5].split(",")) | set(tail[2].split(","))
        result.append(
            {
                "id": values[0],
                "parent": values[1],
                "device": values[2],
                "root": values[3],
                "path": target,
                "kind": tail[0],
                "options": sorted(options & SAFE_OPTIONS),
                "otherOptionsOmitted": len(options - SAFE_OPTIONS),
            }
        )
    return result


def process_metadata(pid: str) -> dict[str, object]:
    if not pid.isdecimal() or int(pid) <= 1:
        return {"status": "UNVERIFIED: no active API PID"}
    proc = Path("/proc") / pid
    allowed = {
        "Uid",
        "Gid",
        "Groups",
        "NSpid",
        "NoNewPrivs",
        "CapEff",
        "CapPrm",
        "Seccomp",
    }
    result: dict[str, object] = {}
    try:
        result["status"] = dict(
            line.split(":", 1)
            for line in read(proc / "status").splitlines()
            if line.split(":", 1)[0] in allowed
        )
        result["namespaces"] = {
            name: os.readlink(proc / "ns" / name) for name in ("pid", "mnt", "user")
        }
        result["mounts"] = mount_metadata(proc / "mountinfo")
    except OSError as error:
        result["inspection"] = {
            "status": "UNVERIFIED: PID unavailable or access refused",
            "errno": error.errno,
        }
    return result


def main() -> None:
    if sys.platform != "linux" or sys.argv[1:]:
        sys.exit("Only the fixed Linux read-only metadata audit is supported")
    import pwd

    def expired(_signum: int, _frame: object) -> None:
        raise TimeoutError("read-only audit deadline")

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(35)
    try:
        account = pwd.getpwnam("shop")
        identity = {
            "uid": account.pw_uid,
            "gid": account.pw_gid,
            "groups": os.getgrouplist("shop", account.pw_gid),
        }
    except KeyError:
        identity = {"status": "UNVERIFIED: shop account absent"}
    properties = command(
        "systemctl",
        "show",
        "--no-pager",
        "shop-api.service",
        "--property=" + ",".join(PROPERTIES),
    )
    unit = dict(line.split("=", 1) for line in properties.splitlines() if "=" in line)
    ancestors = {"/"}
    for root in ROOTS:
        ancestors.add(root)
        ancestors.update(str(path) for path in Path(root).parents)
    api = process_metadata(unit.get("MainPID", "0"))
    try:
        disk = os.statvfs(ROOTS[0])
        capacity = {
            "availableBytes": disk.f_bavail * disk.f_frsize,
            "availableInodes": disk.f_favail,
        }
    except OSError as error:
        capacity = {"status": "UNVERIFIED", "errno": error.errno}
    print(
        json.dumps(
            {
                "status": "READ_ONLY_AUDIT; operational acceptance remains unverified",
                "shop": identity,
                "systemd": command("systemctl", "--version").splitlines()[:1],
                "kernel": os.uname().release,
                "apiUnit": unit,
                "api": api,
                "managerPidNamespace": os.readlink("/proc/1/ns/pid"),
                "paths": [metadata(path) for path in sorted(ancestors)],
                "mounts": mount_metadata(Path("/proc/self/mountinfo")),
                "capacity": capacity,
                "productionApply": "SANDBOX_UNVERIFIED",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
