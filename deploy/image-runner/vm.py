"""Networkless QEMU/TCG fixture VM, inside an unprivileged bounded container only.

No KVM, host namespaces, Docker socket, SSH, shared guest filesystem or credentials.
The caller supplies only a NEW volume at /vm and selected read-only fixture sources.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

IMAGE = "ubuntu-26.04-server-cloudimg-amd64.img"
IMAGE_URL = "https://cloud-images.ubuntu.com/releases/resolute/release/" + IMAGE
IMAGE_SHA256 = "8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2"
ROOT = Path("/vm")
SOURCE = Path("/fixture-repo")
RESULT = "IMAGE_ACCEPTANCE_RESULT="


def command(args: list[str], timeout: int = 30) -> None:
    subprocess.run(args, check=True, timeout=timeout, stdin=subprocess.DEVNULL)


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def prepare() -> None:
    if ROOT.resolve(strict=True) != ROOT or any(ROOT.iterdir()):
        raise RuntimeError("new empty /vm volume required")
    disk = os.statvfs(ROOT)
    if disk.f_bavail * disk.f_frsize < 8 * 1024**3:
        raise RuntimeError("VM fixture requires at least 8 GiB available; NOT VERIFIED")
    (ROOT / "fixture-vm-v1").write_text("disposable image acceptance only\n")
    command(
        [
            "curl",
            "--fail",
            "--location",
            "--proto",
            "=https",
            "--max-time",
            "600",
            "--max-filesize",
            str(1024**3),
            "--output",
            str(ROOT / IMAGE),
            IMAGE_URL,
        ],
        timeout=610,
    )
    if sha256(ROOT / IMAGE) != IMAGE_SHA256:
        raise RuntimeError("Ubuntu image digest mismatch; no guest started")
    print(json.dumps({"imageSha256": IMAGE_SHA256, "prepared": True}), flush=True)


def run(scope: str = "full") -> int:
    if scope not in (
        "full",
        "child-oom",
        "lifecycle",
        "namespace-positive",
        "security",
        "security-api",
        "application",
        "application-api",
        "application-worker",
        "readiness-encode",
        "readiness-launcher",
        "readiness-stop",
        "readiness-db",
        "readiness-production",
    ):
        raise ValueError("unknown fixture scope")
    if (ROOT / "fixture-vm-v1").read_text() != "disposable image acceptance only\n":
        raise RuntimeError("not an owned fixture volume")
    if sha256(ROOT / IMAGE) != IMAGE_SHA256:
        raise RuntimeError("Ubuntu image digest mismatch")
    # Exclusive outputs forbid accidental reuse/resume of a previously booted VM.
    seed = ROOT / "seed"
    seed.mkdir()
    files = []
    source_hashes: dict[str, str] = {}
    selected = (
        sorted((SOURCE / "deploy/image-runner").glob("*.py"))
        + sorted((SOURCE / "deploy/image-runner").glob("*.mjs"))
        + [
            SOURCE / "deploy/image-runner/api-isolation.conf.example",
            SOURCE / "deploy/shop-api.service",
            SOURCE / "deploy/shop-image-runner@.service",
            SOURCE / "deploy/shop-image-runner-pin@.target",
            SOURCE / "apps/api/data/product-image-production/environment.ts",
        ]
    )
    for path in selected:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 128 * 1024:
            raise RuntimeError("unsafe fixture source")
        destination = "/opt/fixture-repo/" + path.relative_to(SOURCE).as_posix()
        data = path.read_bytes()
        source_hashes[path.relative_to(SOURCE).as_posix()] = hashlib.sha256(
            data
        ).hexdigest()
        files.append(
            {
                "path": destination,
                "permissions": "0644",
                "encoding": "b64",
                "content": base64.b64encode(data).decode("ascii"),
            }
        )
    # JSON is valid YAML. No interpolation into a shell or arbitrary user command.
    user_data = {
        "ssh_pwauth": False,
        "disable_root": True,
        "write_files": files
        + [
            {
                "path": "/etc/image-acceptance-disposable",
                "permissions": "0600",
                "content": "isolated-image-fixtures-v1\n",
            }
        ],
        "runcmd": [
            [
                "python3",
                "-B",
                "/opt/fixture-repo/deploy/image-runner/acceptance.py",
                *([] if scope == "full" else ["--" + scope]),
            ]
        ],
        "power_state": {"mode": "poweroff", "timeout": 30, "condition": True},
    }
    (seed / "user-data").write_text(
        "#cloud-config\n" + json.dumps(user_data), encoding="utf-8"
    )
    (seed / "meta-data").write_text(
        "instance-id: image-acceptance-disposable\nlocal-hostname: image-acceptance\n"
    )
    (seed / "network-config").write_text(json.dumps({"version": 2, "ethernets": {}}))
    command(
        [
            "genisoimage",
            "-quiet",
            "-output",
            str(ROOT / "seed.iso"),
            "-volid",
            "cidata",
            "-joliet",
            "-rock",
            str(seed),
        ]
    )
    command(
        [
            "qemu-img",
            "create",
            "-f",
            "qcow2",
            "-F",
            "qcow2",
            "-b",
            str(ROOT / IMAGE),
            str(ROOT / "overlay.qcow2"),
            "6G",
        ]
    )
    if scope in (
        "application",
        "application-api",
        "application-worker",
        "readiness-encode",
        "readiness-launcher",
        "readiness-stop",
        "readiness-db",
        "readiness-production",
    ):
        artifact = Path("/artifact-input")
        summary = json.loads((artifact / "summary.json").read_text())
        if (
            sha256(artifact / "rootfs.tar") != summary["rootfsSha256"]
            or sha256(artifact / "manifest.json") != summary["manifestSha256"]
            or (artifact / "rootfs.tar").stat().st_size > 512 * 1024**2
        ):
            raise RuntimeError("artifact media digest/size mismatch")
        command(
            [
                "genisoimage",
                "-quiet",
                "-output",
                str(ROOT / "artifact.iso"),
                "-volid",
                "IMAGE_RUNTIME",
                "-joliet",
                "-rock",
                str(artifact),
            ],
            timeout=90,
        )
    if scope == "readiness-db":
        database = Path("/db-input")
        summary = json.loads((database / "summary.json").read_text())
        if (
            sha256(database / "rootfs.tar") != summary["rootfsSha256"]
            or sha256(database / "manifest.json") != summary["manifestSha256"]
            or (database / "rootfs.tar").stat().st_size > 512 * 1024**2
        ):
            raise RuntimeError("DB fixture media mismatch")
        command(
            [
                "genisoimage",
                "-quiet",
                "-output",
                str(ROOT / "db.iso"),
                "-volid",
                "DB_FIXTURE",
                "-joliet",
                "-rock",
                str(database),
            ],
            timeout=90,
        )
    args = [
        "qemu-system-x86_64",
        "-machine",
        "q35,accel=tcg",
        "-cpu",
        "max",
        "-smp",
        "2",
        "-m",
        # Keep the DB/compiler guest below the unchanged 3 GiB outer envelope.
        # This does not change any application/runner cgroup limit.
        "1536" if scope == "readiness-db" else "2048",
        "-display",
        "none",
        "-serial",
        "stdio",
        "-monitor",
        "none",
        "-no-reboot",
        "-nic",
        "none",
        # Official systemd v256+ credential: skip only the fresh guest's network
        # bootstrap waiter, before cloud-init (not a runner policy override).
        "-smbios",
        "type=11,value=io.systemd.credential.binary:systemd.unit-dropin.systemd-networkd-wait-online.service="
        + base64.b64encode(
            b"[Unit]\nConditionPathExists=/run/image-acceptance-network-required\n"
        ).decode("ascii"),
        "-drive",
        f"file={ROOT / 'overlay.qcow2'},if=virtio,format=qcow2",
        "-drive",
        f"file={ROOT / 'seed.iso'},if=virtio,format=raw,readonly=on",
    ]
    if scope in (
        "application",
        "application-api",
        "application-worker",
        "readiness-encode",
        "readiness-launcher",
        "readiness-stop",
        "readiness-db",
        "readiness-production",
    ):
        args += [
            "-drive",
            f"file={ROOT / 'artifact.iso'},if=virtio,format=raw,readonly=on",
        ]
    if scope == "readiness-db":
        args += ["-drive", f"file={ROOT / 'db.iso'},if=virtio,format=raw,readonly=on"]
    log = ROOT / "serial.log"
    with log.open("xb") as output:
        child = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
        )
        deadline = time.monotonic() + 1200
        try:
            while child.poll() is None:
                if time.monotonic() > deadline or log.stat().st_size > 8 * 1024**2:
                    raise RuntimeError("VM runtime/log limit; NOT VERIFIED")
                time.sleep(1)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
    content = log.read_text(errors="replace")
    reports = [
        line.split(RESULT, 1)[1].strip()
        for line in content.splitlines()
        if RESULT in line
    ]
    if len(reports) != 1:
        print(content[-16000:])
        raise RuntimeError("missing/ambiguous VM result; NOT VERIFIED")
    report = json.loads(reports[0])
    if report.get("selection") != scope:
        raise RuntimeError("guest fixture selection mismatch; NOT VERIFIED")
    report["ubuntuImageSha256"] = IMAGE_SHA256
    report["fixtureSourceSha256"] = source_hashes
    print(json.dumps(report, sort_keys=True), flush=True)
    return 0 if report.get("status") == "PASSED" and child.returncode == 0 else 78


if __name__ == "__main__":
    if (
        sys.platform != "linux"
        or len(sys.argv) not in (2, 3)
        or sys.argv[1] not in ("prepare", "run")
        or (
            len(sys.argv) == 3
            and (
                sys.argv[1] != "run"
                or sys.argv[2]
                not in (
                    "--child-oom",
                    "--lifecycle",
                    "--namespace-positive",
                    "--security",
                    "--security-api",
                    "--application",
                    "--application-api",
                    "--application-worker",
                    "--readiness-encode",
                    "--readiness-launcher",
                    "--readiness-stop",
                    "--readiness-db",
                    "--readiness-production",
                )
            )
        )
    ):
        sys.exit("Only prepare/run inside the disposable VM tooling container")
    os.umask(0o077)
    if sys.argv[1] == "prepare":
        prepare()
    else:
        sys.exit(run(sys.argv[2][2:] if len(sys.argv) == 3 else "full"))
