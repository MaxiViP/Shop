"""Candidate broker transport, unchanged manager/security checks, synthetic paths."""

import base64
import json
import os
from pathlib import Path
import select
import time
import uuid

import application
import artifact
import broker_fixture
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
    accepted_launcher = next(
        item["sha256"]
        for item in manifest["entries"]
        if item["path"] == "opt/image-runner/launcher.py"
    )
    assert (
        artifact.sha(root / "rootfs/opt/image-runner/launcher.py") == accepted_launcher
    )
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
    broker_name = None
    broker_fd = -1
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
        broker_name, broker_identity, broker_fd = broker_fixture.start(instance)
        service_name = f"shop-image-runner@{instance}.service"
        target_name = f"shop-image-runner-pin@{instance}.target"
        unit_path = Path("/etc/systemd/system/shop-image-runner@.service")
        pin_path = Path("/etc/systemd/system/shop-image-runner-pin@.target")
        assert not unit_path.exists() and not pin_path.exists()
        body = render(template, root, unit_path, pin_path, "unused")
        body = (
            "\n".join(
                (
                    "ExecStart=/usr/bin/python3 -I -B /run/broker_fault.py %i"
                    if stop
                    else "ExecStart=/usr/bin/python3 -I -B /run/broker_attack.py %i"
                )
                if line.startswith("ExecStart=")
                else "RuntimeMaxSec=600"
                if line.startswith("RuntimeMaxSec=")
                else "TimeoutStopSec=30"
                if line.startswith("TimeoutStopSec=")
                else line
                for line in body.splitlines()
                if not line.endswith(":/run/systemd/private")
            )
            + "\n"
        )
        body += f"BindReadOnlyPaths={Path(__file__).parent}:/opt/image-runner\n"
        body += f"BindReadOnlyPaths=/run/korzina-manager-broker/{instance}/manager.sock:/run/image-manager.sock\n"
        if not stop:
            body += f"BindReadOnlyPaths={Path(__file__).with_name('broker_attack.py')}:/run/broker_attack.py\n"
        else:
            body += f"BindReadOnlyPaths={Path(__file__).with_name('broker_fault.py')}:/run/broker_fault.py\n"
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
            "managerBroker": broker_identity,
        }
        (root / "input/request.json").write_text(json.dumps(request) + "\n")
        (root / "input/request.json").chmod(0o600)
        broker_fixture.bind(instance, root / "input/request.json", unit_path, pin_path)
        if not stop:
            broker_fixture.outsiders(
                instance, artifact.sha(root / "input/request.json")
            )
        inputs = tree(root / "input")
        application.command("systemctl", "daemon-reload")
        if not stop:
            impostor = Path(
                "/run/systemd/system", "image-broker-impostor-" + instance + ".service"
            )
            impostor.write_text(
                "\n".join(
                    f"ExecStart=/usr/bin/python3 -I -B /run/broker_attack.py {instance} --outsider"
                    if line.startswith("ExecStart=")
                    else line
                    for line in unit_path.read_text().splitlines()
                )
                + "\n"
            )
            application.command("systemctl", "daemon-reload")
            try:
                application.command("systemctl", "start", impostor.name)
                rejected = wait_done(impostor.name, 15)
                log = application.logs(impostor.name)
                print("BROKER_IMPOSTOR_LOG=" + log, flush=True)
                assert (
                    rejected["Result"] == "success"
                    and "BROKER_WRONG_UNIT=REFUSED" in log
                )
            finally:
                application.command("systemctl", "stop", impostor.name)
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
        if stop:
            assert "BROKER_FAULT_RESULT=" in journal
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
        # A manual restart must refuse the retained descriptor before a new child.
        application.command("systemctl", "start", service_name)
        restarted = wait_done(service_name, 30)
        assert restarted["MainPID"] == "0" and restarted["ExecMainStatus"] == "78"
        assert restarted["NFileDescriptorStore"] == "1" and group_quiescent(
            group, restarted["ActiveState"]
        )
        assert '"reason": "FENCE_BUSY"' in application.logs(service_name)
        import subprocess

        pin_stop = subprocess.run(
            ["systemctl", "stop", target_name],
            capture_output=True,
            timeout=5,
            check=False,
        )
        assert (
            pin_stop.returncode != 0
            and runner.show(target_name)["ActiveState"] == "active"
        )
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
        broker_log = application.logs(broker_name)
        print("BROKER_CHECKED_LOG=" + broker_log, flush=True)
        audits = [
            json.loads(line.split("=", 1)[1])
            for line in broker_log.splitlines()
            if line.startswith("BROKER_AUDIT=")
        ]
        assert sum(item["decision"] == "ALLOWED" for item in audits) >= 3
        if not stop:
            assert {
                "MESSAGE_CALLER_MISMATCH",
                "REQUEST_REFUSED",
                "CALLER_REFUSED",
                "DUPLICATE_KEY",
                "MESSAGE_LIMIT",
            } <= {item.get("reason") for item in audits}
            assert "BROKER_ATTACK_RESULT=" in journal
        print(
            "READINESS_RESULT="
            + json.dumps(
                {
                    "launcher": "stopped" if stop else "inspection passed",
                    "launcherCandidateSha256": artifact.sha(
                        repo / "deploy/image-runner/launcher.py"
                    ),
                    "managerTransport": "root-only pidfd-authenticated read-only broker; no manager bus mount",
                    "retainedRestartRefused": True,
                    "pinManualStopRefused": True,
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
        if broker_name:
            print("BROKER_FINAL_LOG=" + application.logs(broker_name), flush=True)
            application.command("systemctl", "stop", broker_name)
            assert runner.show(broker_name)["MainPID"] == "0"
        if broker_fd >= 0:
            assert not broker_fixture.broker.live(broker_fd)
            os.close(broker_fd)
        for fd in descriptors.values():
            os.close(fd)
        # Do not clear FDSTORE, stop the pinned target, unlink or replace its fence.
        # The owned VM shuts down after exporting evidence.
