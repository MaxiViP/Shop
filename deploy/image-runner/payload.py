"""Fixed disposable-test payloads; no image runner apply path or application imports."""

import array
import errno
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
    import mmap
    import threading

    # One allocator is synchronously throttled even inside MAP_POPULATE, before
    # reaching memory.max. A fixed 32-thread burst faults a total of 1 GiB in the
    # chosen parent/child process. THP advice batches faults; readv releases the
    # Python GIL. No cgroup limits, capabilities, or runtime deadlines change.
    memory = mmap.mmap(
        -1,
        1024**3,
        flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS,
        prot=mmap.PROT_READ | mmap.PROT_WRITE,
    )
    memory.madvise(mmap.MADV_HUGEPAGE)
    barrier = threading.Barrier(32)
    zero = os.open("/dev/zero", os.O_RDONLY | os.O_CLOEXEC)

    def fault(index: int) -> None:
        barrier.wait()
        size = 32 * 1024**2
        with memoryview(memory)[index * size : (index + 1) * size] as part:
            if os.readv(zero, [part]) != size:
                raise RuntimeError("incomplete OOM fixture page faults")

    threads = [threading.Thread(target=fault, args=(index,)) for index in range(32)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    os.close(zero)
    raise RuntimeError("memory.max did not kill the bounded OOM fixture")


def wait_for(path: Path) -> None:
    while not path.exists():
        time.sleep(0.01)  # The fixture unit has an independent hard runtime limit.


def pressure(mode: str, folder: Path) -> None:
    wait_for(folder / "start")
    if mode == "cpu":
        while True:
            pass
    elif mode == "tasks":
        for _ in range(80):
            try:
                if os.fork() == 0:
                    forever()
            except OSError as error:
                if error.errno != errno.EAGAIN:
                    raise
                (folder / "task-limit").write_text("EAGAIN")
                forever()
        raise RuntimeError("task limit was not enforced")


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
        signal.signal(
            signal.SIGTERM,
            (lambda *_: sys.exit(0)) if mode == "graceful" else (lambda *_: None),
        )
        # Every lifecycle case must retain admission across stop/kill/OOM/timeout.
        # The fence was freshly created by this disposable test, never production.
        import launcher

        fd = launcher.acquire_fence(folder / "deploy.lock")
        launcher.notify_store(fd, os.environ.get("NOTIFY_SOCKET", ""))
        first = os.fork()
        if first == 0:
            os.close(fd)  # Only systemd retains the fence after the main process dies.
            os.setsid()
            if mode == "child-memory":
                (folder / "child-ready").write_text("ready", encoding="ascii")
                wait_for(folder / "start")
                allocate()
            second = os.fork()
            if second == 0:
                (folder / "grandchild-ready").write_text("ready", encoding="ascii")
                if mode == "cpu":
                    pressure(mode, folder)
                forever()
            (folder / "child-ready").write_text("ready", encoding="ascii")
            if mode == "orphan":
                os._exit(0)  # Grandchild is reparented after double fork + setsid.
            if mode == "cpu":
                pressure(mode, folder)
            forever()
        wait_for(folder / "child-ready")
        if mode != "child-memory":
            wait_for(folder / "grandchild-ready")
        if mode == "orphan":
            os.waitpid(first, 0)
        (folder / "ready").write_text("ready", encoding="ascii")
        if mode == "parent-memory":
            wait_for(folder / "start")
            allocate()
        if mode in ("cpu", "tasks"):
            pressure(mode, folder)
        forever()
    else:
        sys.exit(64)
