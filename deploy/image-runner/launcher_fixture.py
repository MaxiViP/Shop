"""Actual unchanged inspector, exact manager policy, synthetic identity and paths."""

import base64
import json
import os
from pathlib import Path
import select
import time
import uuid

import application
import artifact
import launcher as runner
from test_namespace import render
from test_systemd import group_quiescent

UID, GID = (
    997,
    55001,
)  # Synthetic GID deliberately differs from UID; not target evidence.
IMAGE = "UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoIAAYAAUAmJaACdLoB+AADsAD+7/3D/ziWOp3dB//zBK/INyoAAA=="


def metadata(path: Path) -> dict[str, object]:
    return {
        "dev": path.stat().st_dev,
        "ino": path.stat().st_ino,
        "uid": path.stat().st_uid,
        "gid": path.stat().st_gid,
        "mode": path.stat().st_mode,
        "mtime": path.stat().st_mtime_ns,
        "sha256": artifact.sha(path) if path.is_file() else None,
    }


def tree(root: Path) -> dict[str, object]:
    return {
        str(path.relative_to(root)): metadata(path) for path in [root, *root.rglob("*")]
    }


def nss(body: str, root: Path) -> str:
    for name in ("passwd", "group"):
        body += f"BindReadOnlyPaths={root / name}:/etc/{name}\n"
    return body


def wait_done(service: str, seconds: int) -> dict[str, str]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        state = runner.show(service)
        if state["ActiveState"] not in ("active", "activating", "deactivating"):
            return state
        time.sleep(0.25)
    raise AssertionError("fixture deadline; unit must be stopped and evidence retained")


def run(root: Path, manifest: dict[str, object], stop: bool) -> None:
    repo = Path(__file__).resolve().parents[2]
    template = (repo / "deploy/shop-image-runner@.service").read_text()
    pin_template = (repo / "deploy/shop-image-runner-pin@.target").read_text()
    assert artifact.sha(repo / "deploy/image-runner/launcher.py") == next(
        item["sha256"]
        for item in manifest["entries"]
        if item["path"] == "opt/image-runner/launcher.py"
    ), "launcher source must match accepted artifact exactly"
    storage = root / "storage"
    storage.mkdir(mode=0o755)
    for name in ("products", "chat", "product-variants", ".product-image-state"):
        (storage / name).mkdir(mode=0o700)
        os.chown(storage / name, UID, GID)
    source = storage / "products" / "550e8400-e29b-41d4-a716-446655440001.webp"
    source.write_bytes(base64.b64decode(IMAGE))
    source.chmod(0o600)
    os.chown(source, UID, GID)
    original = tree(storage)
    (root / "input").mkdir(mode=0o755)
    info = source.stat()
    entry = {
        "schemaVersion": 1,
        "url": "/uploads/products/" + source.name,
        "source": {
            "bytes": info.st_size,
            "sha256": artifact.sha(source),
            "fingerprint": {
                "mtimeNs": str(info.st_mtime_ns),
                "dev": str(info.st_dev),
                "ino": str(info.st_ino),
            },
        },
    }
    (root / "input/inventory.jsonl").write_text(json.dumps(entry) + "\n")
    for name in ("request.json", "approval.json"):
        (root / "input" / name).write_text("{}\n")
    fence = root / "deploy.lock"
    fence.write_text("new disposable deploy fence only\n")
    fence.chmod(0o600)
    fence_before = metadata(fence)
    (root / "passwd").write_text(
        "root:x:0:0:root:/nonexistent:/nonexistent\nshop:x:997:55001:fixture:/nonexistent:/nonexistent\n"
    )
    (root / "group").write_text("root:x:0:\nshop:x:55001:\n")
    prep = Path("/run/systemd/system") / (
        "image-launcher-prepare-" + uuid.uuid4().hex + ".service"
    )
    prep_pin = prep.with_suffix(".target")
    body = render(template, root, prep, prep_pin, "prepare")
    body = (
        "\n".join(
            "ExecStart=/usr/bin/python3 -I -B /run/readiness.py prepare"
            if line.startswith("ExecStart=")
            else "RuntimeMaxSec=100"
            if line.startswith("RuntimeMaxSec=")
            else line
            for line in body.splitlines()
        )
        + f"\nBindReadOnlyPaths={Path(__file__).with_name('launcher_prepare.mjs')}:/run/launcher_prepare.mjs\nBindReadOnlyPaths={Path(__file__).with_name('readiness.py')}:/run/readiness.py\n"
    )
    prep.write_text(nss(body, root))
    prep_pin.write_text("[Unit]\nDescription=Disposable read-only proposal only\n")
    service_name = None
    descriptors: dict[int, int] = {}
    group = None
    try:
        application.command("systemctl", "daemon-reload")
        application.command("systemctl", "start", prep.name)
        prepared = wait_done(prep.name, 110)
        journal = application.logs(prep.name)
        print("LAUNCHER_PREPARE_LOG=" + journal, flush=True)
        assert prepared["Result"] == "success", prepared
        proposals = [
            json.loads(line.split("=", 1)[1])
            for line in journal.splitlines()
            if line.startswith("LAUNCHER_PROPOSAL=")
        ]
        assert len(proposals) == 1 and tree(storage) == original
        proposal = proposals[0]
        instance = proposal["runId"]
        assert runner.UUID.fullmatch(instance)
        service_name = f"shop-image-runner@{instance}.service"
        target_name = f"shop-image-runner-pin@{instance}.target"
        unit_path = Path("/etc/systemd/system/shop-image-runner@.service")
        pin_path = Path("/etc/systemd/system/shop-image-runner-pin@.target")
        assert not unit_path.exists() and not pin_path.exists()
        body = render(template, root, unit_path, pin_path, "unused")
        body = (
            "\n".join(
                "ExecStart=/usr/bin/python3 -I -B /run/launcher_entry.py %i"
                if line.startswith("ExecStart=")
                else "RuntimeMaxSec=600"
                if line.startswith("RuntimeMaxSec=")
                else "TimeoutStopSec=30"
                if line.startswith("TimeoutStopSec=")
                else line
                for line in body.splitlines()
            )
            + "\n"
        )
        body += f"BindReadOnlyPaths={Path(__file__).with_name('launcher_entry.py')}:/run/launcher_entry.py\n"
        unit_path.write_text(nss(body, root))
        pin_path.write_text(pin_template)
        approval = root / "input/approval.json"
        approval.write_text(json.dumps(proposal) + "\n")
        request = {
            "schemaVersion": 1,
            "kind": "image-sandbox-inspection",
            "runId": instance,
            "batchSize": 1,
            "inventorySha256": artifact.sha(root / "input/inventory.jsonl"),
            "approvalSha256": artifact.sha(approval),
            "launcherSha256": artifact.sha(repo / "deploy/image-runner/launcher.py"),
            "unitSha256": artifact.sha(unit_path),
            "pinSha256": artifact.sha(pin_path),
        }
        (root / "input/request.json").write_text(json.dumps(request) + "\n")
        inputs = tree(root / "input")
        application.command("systemctl", "daemon-reload")
        application.command("systemctl", "start", target_name)
        deadline = time.monotonic() + 75
        admitted = False
        child_status = None
        while time.monotonic() < deadline:
            state = runner.show(service_name)
            group = (
                Path("/sys/fs/cgroup") / state["ControlGroup"].lstrip("/")
                if state["ControlGroup"]
                else group
            )
            if group and group.exists():
                for value in (group / "cgroup.procs").read_text().split():
                    pid = int(value)
                    try:
                        if pid not in descriptors:
                            descriptors[pid] = os.pidfd_open(pid)
                        status = Path(f"/proc/{pid}/status").read_text()
                    except (FileNotFoundError, ProcessLookupError):
                        continue
                    fields = dict(
                        line.split(":", 1)
                        for line in status.splitlines()
                        if ":" in line
                    )
                    if fields["Uid"].split() == [str(UID)] * 4:
                        child_status = status
            if state["NFileDescriptorStore"] == "1":
                admitted = True
                try:
                    fd = runner.acquire_fence(fence)
                except runner.Refused as error:
                    assert str(error) == "FENCE_BUSY"
                else:
                    os.close(fd)
                    raise AssertionError("deploy admitted while inspector owns fence")
                if stop and child_status:
                    application.command("systemctl", "stop", service_name)
                    break
            if state["ActiveState"] in ("failed", "inactive"):
                break
            time.sleep(0.1)
        final = wait_done(service_name, 40)
        journal = application.logs(service_name)
        print("FULL_LAUNCHER_LOG=" + journal, flush=True)
        assert admitted and group is not None, "launcher never stored fence"
        assert (
            final["MainPID"] == "0"
            and final["ExecMainStatus"] == "78"
            and final["NRestarts"] == "0"
        ), final
        assert final["NFileDescriptorStore"] == "1" and group_quiescent(
            group, final["ActiveState"]
        )
        assert len(select.select(list(descriptors.values()), [], [], 0)[0]) == len(
            descriptors
        )
        reports = [
            json.loads(line)
            for line in journal.splitlines()
            if line.startswith('{"error":')
        ]
        assert reports and (
            reports[-1].get("reason") == "STOP_REQUESTED"
            if stop
            else reports[-1].get("inspection") == "passed"
        ), reports
        assert child_status is not None
        fields = dict(
            line.split(":", 1) for line in child_status.splitlines() if ":" in line
        )
        assert (
            fields["Uid"].split() == [str(UID)] * 4
            and fields["Gid"].split() == [str(GID)] * 4
        )
        assert (
            fields["Groups"].strip() == ""
            and fields["NSpid"].split()[-1] != fields["NSpid"].split()[0]
        )
        assert all(
            int(fields[key], 16) == 0
            for key in ("CapEff", "CapPrm", "CapInh", "CapAmb")
        )
        assert fields["NoNewPrivs"].strip() == "1" and fields["Seccomp"].strip() == "2"
        application.command("systemctl", "daemon-reload")
        assert runner.show(service_name)["NFileDescriptorStore"] == "1"
        try:
            fd = runner.acquire_fence(fence)
        except runner.Refused as error:
            assert str(error) == "FENCE_BUSY"
        else:
            os.close(fd)
            raise AssertionError("retained fence released after exit/reload")
        assert tree(storage) == original and tree(root / "input") == inputs
        assert metadata(fence) == fence_before
        artifact.verify(root / "rootfs", manifest)
        print(
            "READINESS_RESULT="
            + json.dumps(
                {
                    "launcher": "stopped" if stop else "inspection passed",
                    "launcherUnchanged": True,
                    "fixtureRuntimeBootstrap": "private boot marker; production unit still unverified",
                    "productionLimitsUnchanged": True,
                    "uid": UID,
                    "gid": GID,
                    "fence": "BUSY during execution and after exit/reload",
                    "fdStore": 1,
                    "quiescent": True,
                    "observedPidfdsExited": len(descriptors),
                    "restartCount": 0,
                    "artifactUnchanged": True,
                    "syntheticStorageUnchanged": True,
                    "productionApply": "SANDBOX_UNVERIFIED",
                }
            ),
            flush=True,
        )
    finally:
        print("LAUNCHER_PREPARE_FINAL_LOG=" + application.logs(prep.name), flush=True)
        application.command("systemctl", "stop", prep.name)
        if service_name:
            print(
                "FULL_LAUNCHER_FINAL_LOG=" + application.logs(service_name), flush=True
            )
            application.command("systemctl", "stop", service_name)
            assert runner.show(service_name)["MainPID"] == "0"
        for fd in descriptors.values():
            os.close(fd)
        # Do not clear FDSTORE, stop the pinned target, unlink or replace its fence.
        # The owned VM shuts down after exporting evidence.
