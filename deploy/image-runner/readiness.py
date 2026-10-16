"""New fixed readiness fixtures, using the already accepted immutable artifact."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0, "/opt/image-runner")
import launcher as runner


def worker(mode: str = "worker") -> None:
    assert mode in ("worker", "prepare")
    assert os.getpid() == 1 and os.geteuid() == 0
    runner.process_policy(Path("/proc/self/status").read_text())
    group = runner.cgroup_path(Path("/proc/self/cgroup").read_text())
    root = Path("/sys/fs/cgroup") / group.lstrip("/")
    limits = runner.cgroup_policy(
        {
            name: (root / name).read_text()
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
    )
    before = (root / "cpu.stat").read_text()
    result = subprocess.run(
        [
            "/usr/bin/node",
            "--import",
            "tsx",
            "/run/launcher_prepare.mjs" if mode == "prepare" else "/run/diagnostic.mjs",
        ],
        cwd="/artifact/apps/api",
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=160,
        check=False,
        user=997 if mode == "prepare" else 55000,
        group=55001 if mode == "prepare" else 55000,
        extra_groups=[],
        env={
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "NODE_ENV": "production",
            "TSX_DISABLE_CACHE": "1",
            "UV_THREADPOOL_SIZE": "1",
            "TMPDIR": "/tmp",
        },
    )
    print(result.stdout, end="", flush=True)
    print(
        "ENCODE_LIMITS="
        + json.dumps(
            {
                "limits": limits,
                "cpuBefore": before,
                "cpuAfter": (root / "cpu.stat").read_text(),
                "memoryEvents": (root / "memory.events").read_text(),
            }
        ),
        flush=True,
    )
    assert result.returncode == 0 and not result.stderr, result.stderr[:4096]


def run(root: Path, manifest: dict[str, object], scope: str) -> None:
    import application
    import artifact
    from test_namespace import render
    from test_systemd import group_quiescent

    assert scope == "readiness-encode"
    repo = Path(__file__).resolve().parents[2]
    service = Path("/run/systemd/system") / (
        "image-encode-diagnostic-" + uuid.uuid4().hex + ".service"
    )
    pin = service.with_suffix(".target")
    storage = root / "storage"
    storage.mkdir(mode=0o755)
    for name in ("products", "chat", "product-variants", ".product-image-state"):
        (storage / name).mkdir(mode=0o700)
        os.chown(storage / name, 55000, 55000)
    (root / "input").mkdir()
    for name in ("request.json", "inventory.jsonl", "approval.json"):
        (root / "input" / name).write_text("{}\n")
    (root / "deploy.lock").write_text("disposable diagnostic only\n")
    body = render(
        (repo / "deploy/shop-image-runner@.service").read_text(),
        root,
        service,
        pin,
        "diagnostic",
    )
    body = (
        "\n".join(
            "ExecStart=/usr/bin/python3 -I -B /run/readiness.py worker"
            if line.startswith("ExecStart=")
            else "RuntimeMaxSec=180"
            if line.startswith("RuntimeMaxSec=")
            else line
            for line in body.splitlines()
        )
        + "\n"
    )
    for name in ("readiness.py", "diagnostic.mjs"):
        body += f"BindReadOnlyPaths={Path(__file__).with_name(name)}:/run/{name}\n"
    service.write_text(body)
    pin.write_text("[Unit]\nDescription=Disposable encode diagnostic only\n")
    application.command("systemctl", "daemon-reload")
    application.command("systemctl", "start", service.name)
    group = runner.show(service.name)["ControlGroup"]
    deadline = time.monotonic() + 195
    try:
        while (
            runner.show(service.name)["ActiveState"] in ("active", "activating")
            and time.monotonic() < deadline
        ):
            time.sleep(0.5)
        state = runner.show(service.name)
        journal = application.logs(service.name)
        print("ENCODE_UNIT_LOG=" + journal, flush=True)
        assert state["MainPID"] == "0" and state["Result"] == "success", state
        assert group_quiescent(
            Path("/sys/fs/cgroup") / group.lstrip("/"), state["ActiveState"]
        )
        assert state["NRestarts"] == "0"
        reports = [
            json.loads(line.split("=", 1)[1])
            for line in journal.splitlines()
            if line.startswith("ENCODE_DIAGNOSTIC=")
        ]
        assert len(reports) == 1
        artifact.verify(root / "rootfs", manifest)
        assert reports[0]["outcome"] == "SUCCESS", reports[0]
        print(
            "READINESS_RESULT="
            + json.dumps(
                {
                    "encode": reports[0],
                    "cgroupQuiescent": True,
                    "artifactUnchanged": True,
                    "productionApply": "SANDBOX_UNVERIFIED",
                }
            ),
            flush=True,
        )
    finally:
        application.command("systemctl", "stop", service.name)
        assert runner.show(service.name)["MainPID"] == "0"


if __name__ == "__main__":
    assert sys.argv[1:] in (["worker"], ["prepare"])
    worker(sys.argv[1])
