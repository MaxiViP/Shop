"""Fixed disposable-test payloads; no image runner apply path or application imports."""

import array
import os
from pathlib import Path
import signal
import socket
import sys
import time


def forever() -> None:
    while True:
        time.sleep(0.1)


def allocate() -> None:
    blocks: list[bytearray] = []
    while True:
        blocks.append(bytearray(8 * 1024**2))
        time.sleep(0.01)


def wait_for(path: Path) -> None:
    while not path.exists():
        time.sleep(0.01)  # The fixture unit has an independent hard runtime limit.


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "fd-owner":
        import fcntl

        fd = os.open(sys.argv[3], os.O_RDONLY | os.O_NOFOLLOW)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
            channel.connect(sys.argv[2])
            channel.sendmsg(
                [b"owned"],
                [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))],
            )
        forever()
    elif len(sys.argv) == 4 and sys.argv[1] == "lifecycle":
        mode, folder = sys.argv[2], Path(sys.argv[3])
        signal.signal(signal.SIGTERM, lambda *_: None)
        if mode == "fdstore":
            # Used only by disposable systemd tests, with their freshly created empty lock.
            import launcher

            fd = launcher.acquire_fence(folder / "deploy.lock")
            launcher.notify_store(fd, os.environ.get("NOTIFY_SOCKET", ""))
        first = os.fork()
        if first == 0:
            os.setsid()
            if mode == "child-memory":
                (folder / "child-ready").write_text("ready", encoding="ascii")
                wait_for(folder / "start")
                allocate()
            second = os.fork()
            if second == 0:
                (folder / "grandchild-ready").write_text("ready", encoding="ascii")
                forever()
            (folder / "child-ready").write_text("ready", encoding="ascii")
            forever()
        wait_for(folder / "child-ready")
        if mode != "child-memory":
            wait_for(folder / "grandchild-ready")
        (folder / "ready").write_text("ready", encoding="ascii")
        if mode == "parent-memory":
            wait_for(folder / "start")
            allocate()
        forever()
    else:
        sys.exit(64)
