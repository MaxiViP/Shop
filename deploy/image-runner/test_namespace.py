"""Actual template-derived filesystem/privilege acceptance, disposable VM only."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from fs_payload import fingerprint
import launcher as runner
import preflight


def runtime(root: Path) -> None:
    """Copy only the VM's Python runtime/libraries, never host /etc, home or env."""

    def copy(source: Path) -> None:
        target = root / str(source).lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target, follow_symlinks=True)
        target.chmod(source.stat().st_mode & 0o777)

    python = Path("/usr/bin/python3")
    copy(python)
    stdlib = Path(
        subprocess.check_output(
            [
                str(python),
                "-c",
                "import sysconfig; print(sysconfig.get_path('stdlib'))",
            ],
            text=True,
        ).strip()
    )
    shutil.copytree(
        stdlib,
        root / str(stdlib).lstrip("/"),
        ignore=shutil.ignore_patterns(
            "__pycache__",
            "test",
            "tests",
            "dist-packages",
            "site-packages",
            "ensurepip",
            "tkinter",
        ),
    )
    libraries = subprocess.run(
        ["ldd", str(python), *map(str, stdlib.rglob("*.so"))],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    for library in set(re.findall(r"(/[\w.+/-]+)", libraries.stdout)):
        path = Path(library)
        if path.is_file():
            copy(path)
    for directory in (
        "etc",
        "opt/image-runner",
        "artifact/apps/api",
        "storage",
        "input",
        "control",
        "run",
        "tmp",
        "proc",
        "proc/sys/fs/binfmt_misc",
        "sys",
        "dev",
        "dev/mqueue",
        "dev/hugepages",
        "dev/shm",
        "dev/pts",
    ):
        (root / directory).mkdir(parents=True, exist_ok=True)
    (root / "etc/passwd").write_text(
        "root:x:0:0:root:/root:/bin/false\nfixture:x:55000:55000:fixture:/nonexistent:/bin/false\n"
    )
    (root / "etc/group").write_text("root:x:0:\nfixture:x:55000:\n")
    for name in ("launcher.py", "fs_payload.py"):
        shutil.copyfile(
            Path(__file__).with_name(name), root / "opt/image-runner" / name
        )
        (root / "opt/image-runner" / name).chmod(0o644)
    root.chmod(0o755)
    for path in root.rglob("*"):
        if path.is_dir():
            path.chmod(0o755)


def render(template: str, root: Path, service: Path, pin: Path, mode: str) -> str:
    values = {
        "Description": "Disposable image namespace fixture",
        "RequiresMountsFor": str(root),
        "RootDirectory": str(root / "rootfs"),
        "ExecStart": f"/usr/bin/python3 -B /opt/image-runner/fs_payload.py {mode}",
        "RuntimeMaxSec": "60",
        "TimeoutStopSec": "2",
    }
    lines: list[str] = []
    for line in template.splitlines():
        if line.startswith(("#", "Documentation=")):
            continue
        key = line.split("=", 1)[0]
        if key in values:
            line = key + "=" + values[key]
        elif key == "BindPaths":
            line = f"BindPaths={root}/storage:/storage"
        elif key == "BindReadOnlyPaths":
            destination = line.rsplit(":", 1)[1]
            sources = {
                "/storage/products": root / "storage/products",
                "/input/request.json": root / "input/request.json",
                "/input/inventory.jsonl": root / "input/inventory.jsonl",
                "/input/approval.json": root / "input/approval.json",
                "/control/deploy.lock": root / "deploy.lock",
                "/run/systemd/private": Path("/run/systemd/private"),
                "/control/runner.service": service,
                "/control/pin.target": pin,
            }
            line = f"BindReadOnlyPaths={sources[destination]}:{destination}"
        lines.append(line)
    if mode == "exdev":
        lines.append(
            f"BindPaths={root}/storage/product-variants:/storage/product-variants"
        )
    elif mode == "alias":
        lines.append(f"BindPaths={root}/storage/products:/alias")
    body = "\n".join(lines) + "\n"
    if "korzinamarket" in body.lower() or "%i" in body or "--apply" in body:
        raise ValueError("unrendered production reference")
    return body


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd/cgroup VM required"
)
class NamespaceTests(unittest.TestCase):
    def case(self, mode: str) -> None:
        name = "image-namespace-fixture-" + uuid.uuid4().hex
        service, pin = (
            Path("/run/systemd/system") / (name + ".service"),
            Path("/run/systemd/system") / (name + ".target"),
        )
        root = Path(tempfile.mkdtemp(prefix="image-namespace-fixture-")).resolve()
        root.chmod(0o755)
        runtime(root / "rootfs")
        for folder in (
            "storage/products",
            "storage/product-variants",
            "storage/.product-image-state/work",
            "storage/.product-image-state/locks",
            "storage/chat",
            "input",
            "outside-fixture-secrets",
        ):
            path = root / folder
            path.mkdir(parents=True, mode=0o700)
        (root / "storage").chmod(0o755)
        for path in (root / "storage").rglob("*"):
            if path.is_dir():
                os.chown(path, 55000, 55000)
                path.chmod(0o700)
        original = root / "storage/products/550e8400-e29b-41d4-a716-446655440001.webp"
        original.write_bytes(b"synthetic filesystem probe, not a shop photograph")
        os.chown(original, 55000, 55000)
        original.chmod(0o600)
        before = fingerprint(original)
        unknown = root / "storage/.product-image-state/locks/unknown.lock"
        unknown.write_bytes(b'{"pid":99999999,"age":"ancient","owner":"unknown"}')
        os.chown(unknown, 55000, 55000)
        unknown.chmod(0o600)
        unknown_before = fingerprint(unknown)
        secret = root / "outside-fixture-secrets/fixture-api.env"
        secret.write_text(
            "DATABASE_URL=synthetic-sentinel\nTELEGRAM_BOT_TOKEN=synthetic-sentinel\n"
        )
        os.chown(secret, 55000, 55000)
        os.chown(secret.parent, 55000, 55000)
        (root / "deploy.lock").write_bytes(b"separate namespace fixture fence")
        (root / "deploy.lock").chmod(0o600)
        fence_before = fingerprint(root / "deploy.lock")
        foreign = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(120)"],
            user=55000,
            group=55000,
            extra_groups=[],
            close_fds=True,
            env={"DATABASE_URL": "synthetic-sentinel"},
            stdin=subprocess.DEVNULL,
        )
        (root / "input/request.json").write_text(
            json.dumps(
                {
                    "foreignPid": foreign.pid,
                    "outsideSecret": str(secret),
                    "hostNamespaces": {
                        name: os.readlink(f"/proc/self/ns/{name}")
                        for name in ("mnt", "pid", "net", "ipc", "user")
                    },
                }
            )
        )
        (root / "input/request.json").chmod(0o644)
        for file in ("inventory.jsonl", "approval.json"):
            path = root / "input" / file
            path.write_text('{"synthetic":"fixture-only"}\n')
            os.chown(path, 55000, 55000)
            path.chmod(0o600)
        inventory_before = fingerprint(root / "input/inventory.jsonl")
        template = Path(__file__).resolve().parents[1] / "shop-image-runner@.service"
        body = render(template.read_text(), root, service, pin, mode)
        # Fixture description cannot inherit the production brand/name either.
        body = re.sub(
            r"^Description=.*$",
            "Description=Disposable image namespace fixture",
            body,
            flags=re.M,
        )
        pin_body = f"[Unit]\nWants={service.name}\nAfter={service.name}\nRefuseManualStop=yes\nIgnoreOnIsolate=yes\n"
        with service.open("x") as output:
            output.write(body)
        with pin.open("x") as output:
            output.write(pin_body)

        def command(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["systemctl", *args],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )

        quiescent = False
        try:
            self.assertEqual(command("daemon-reload").returncode, 0)
            started = command("start", pin.name)
            self.assertEqual(started.returncode, 0, started.stderr)
            deadline = time.monotonic() + 65
            while time.monotonic() < deadline:
                values = runner.show(service.name)
                group = (
                    Path("/sys/fs/cgroup") / values["ControlGroup"].lstrip("/")
                    if values["ControlGroup"]
                    else None
                )
                if values["ActiveState"] in ("inactive", "failed") and (
                    group is None
                    or not group.exists()
                    or "populated 0" in (group / "cgroup.events").read_text()
                ):
                    quiescent = True
                    break
                time.sleep(0.05)
            logs = subprocess.run(
                ["journalctl", "--unit", service.name, "--no-pager", "-o", "cat"],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            ).stdout
            self.assertTrue(
                quiescent, "fixture still populated: retain all objects for VM teardown"
            )
            self.assertEqual(values["Result"], "success", logs)
            reports = [
                line.split("NAMESPACE_RESULT=", 1)[1]
                for line in logs.splitlines()
                if "NAMESPACE_RESULT=" in line
            ]
            self.assertEqual(len(reports), 1, logs)
            report = json.loads(reports[0])
            self.assertEqual(values["User"], "")
            self.assertEqual(values["Group"], "root")
            if mode == "positive":
                self.assertEqual(report["worker"]["nativeLinkFsyncNoClobber"], "PASSED")
                self.assertEqual(values["NFileDescriptorStore"], "1")
                with self.assertRaisesRegex(runner.Refused, "FENCE_BUSY"):
                    runner.acquire_fence(root / "deploy.lock")
                self.assertEqual(fingerprint(root / "deploy.lock"), fence_before)
            else:
                self.assertIn(
                    report["result"], ("LINK_MOUNT_MISMATCH", "WRITABLE_ALIAS")
                )
            self.assertEqual(fingerprint(original), before)
            self.assertEqual(fingerprint(unknown), unknown_before)
            self.assertEqual(
                fingerprint(root / "input/inventory.jsonl"), inventory_before
            )
            self.assertEqual(runner.show(service.name)["NRestarts"], "0")
            print("FIXTURE_EVIDENCE=" + json.dumps(report, sort_keys=True), flush=True)
        finally:
            foreign.terminate()
            foreign.wait(timeout=5)
            if quiescent:
                self.assertEqual(fingerprint(root / "deploy.lock"), fence_before)
                self.assertEqual(command("reset-failed", service.name).returncode, 0)
                self.assertEqual(
                    command("clean", "--what=fdstore", service.name).returncode, 0
                )
                pin.write_text(
                    pin_body.replace("RefuseManualStop=yes", "RefuseManualStop=no")
                )
                command("daemon-reload")
                command("stop", pin.name)
                command("reset-failed", service.name)
                service.unlink()
                pin.unlink()
                command("daemon-reload")
                assert root.parent == Path(
                    tempfile.gettempdir()
                ).resolve() and root.name.startswith("image-namespace-fixture-")
                shutil.rmtree(root)
            else:
                self.fail(
                    "NOT VERIFIED: discard the dedicated VM; fixture cleanup refused"
                )

    def test_actual_template_namespace(self) -> None:
        self.case("positive")

    def test_native_exdev_and_admission_refusal(self) -> None:
        self.case("exdev")

    def test_writable_alias_admission_refusal(self) -> None:
        self.case("alias")
