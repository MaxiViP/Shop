"""New networkless VM from a verified RO cache and a local enumerated artifact."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

from artifact_host import digest

REPO = Path(__file__).resolve().parents[2]
IMAGE = "korzina-image-acceptance-tools:5b2b"
IMAGE_ID = "sha256:c28c337003b4da18fbc3074017c1dfa5592d74bb462fa83f9861ca579b65f35f"
CACHE = "image-acceptance-5c9c822361e1409e983fb65a8b91732b"
BASE = "ubuntu-26.04-server-cloudimg-amd64.img"
BASE_SHA = "8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2"


def main() -> None:
    if (
        os.name != "nt"
        or len(sys.argv) not in (3, 4, 6)
        or sys.argv[1] != "--artifact"
        or (
            len(sys.argv) >= 4
            and sys.argv[3]
            not in (
                "--api-only",
                "--worker-only",
                "--encode-only",
                "--launcher-only",
                "--launcher-stop",
                "--db-only",
            )
        )
        or (len(sys.argv) == 6 and sys.argv[3:5] != ["--db-only", "--db-artifact"])
        or (len(sys.argv) == 4 and sys.argv[3] == "--db-only")
    ):
        raise ValueError("fixed local --artifact WORK/BUILD/artifact only")
    artifact = Path(sys.argv[2]).resolve(strict=True)
    if (
        artifact.name != "artifact"
        or artifact.parent.parent != REPO / "work"
        or not artifact.parent.name.startswith("linux-artifact-")
        or artifact.is_symlink()
    ):
        raise ValueError("only a local owned artifact is accepted")
    summary = json.loads((artifact / "summary.json").read_text())
    if (
        digest(artifact / "rootfs.tar") != summary["rootfsSha256"]
        or digest(artifact / "manifest.json") != summary["manifestSha256"]
    ):
        raise ValueError("artifact digest mismatch")
    name = "image-application-" + uuid.uuid4().hex
    output = REPO / "work" / name
    output.mkdir(exist_ok=False)
    snapshot = output / "source"
    sources = (
        list((REPO / "deploy/image-runner").glob("*.py"))
        + list((REPO / "deploy/image-runner").glob("*.mjs"))
        + [
            REPO / "deploy/image-runner/api-isolation.conf.example",
            REPO / "deploy/shop-api.service",
            REPO / "deploy/shop-image-runner@.service",
            REPO / "deploy/shop-image-runner-pin@.target",
            REPO / "apps/api/data/product-image-production/environment.ts",
        ]
    )
    hashes = {}
    for source in sources:
        if (
            source.is_symlink()
            or not source.is_file()
            or source.stat().st_size > 128 * 1024
        ):
            raise ValueError("unsafe source snapshot")
        target = snapshot / source.relative_to(REPO)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        hashes[source.relative_to(REPO).as_posix()] = digest(target)
    (output / "source.json").write_text(json.dumps(hashes, indent=2) + "\n")
    (output / "artifact.json").write_text(
        json.dumps({"path": str(artifact), **summary}, indent=2) + "\n"
    )
    db_artifact = None
    if len(sys.argv) == 6:
        db_artifact = Path(sys.argv[5]).resolve(strict=True)
        if (
            db_artifact.name != "artifact"
            or db_artifact.parent.parent != REPO / "work"
            or not db_artifact.parent.name.startswith("linux-postgres-")
            or db_artifact.is_symlink()
        ):
            raise ValueError(
                "only a local exported fixture PostgreSQL artifact is accepted"
            )
        db_summary = json.loads((db_artifact / "summary.json").read_text())
        if (
            digest(db_artifact / "rootfs.tar") != db_summary["rootfsSha256"]
            or digest(db_artifact / "manifest.json") != db_summary["manifestSha256"]
            or db_summary["sourceImage"]
            != "postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af"
        ):
            raise ValueError("PostgreSQL fixture artifact mismatch")
        (output / "db-artifact.json").write_text(
            json.dumps({"path": str(db_artifact), **db_summary}, indent=2) + "\n"
        )
    print("APPLICATION_OUTPUT=" + str(output), flush=True)
    with tempfile.TemporaryDirectory(prefix="korzina-application-client-") as client:
        docker = [
            "docker",
            "--host",
            "npipe:////./pipe/docker_engine",
            "--config",
            client,
        ]

        def call(args: list[str], log: str, timeout: int = 30) -> None:
            path = output / log
            with path.open("x", encoding="utf-8") as stream:
                child = subprocess.Popen(
                    docker + args,
                    stdin=subprocess.DEVNULL,
                    stdout=stream,
                    stderr=subprocess.STDOUT,
                )
                deadline = time.monotonic() + timeout
                heartbeat = 0.0
                try:
                    while child.poll() is None:
                        if (
                            time.monotonic() > deadline
                            or path.stat().st_size > 8 * 1024**2
                        ):
                            raise RuntimeError("bounded operation limit: " + log)
                        if time.monotonic() >= heartbeat:
                            print(
                                f"{log}: running; {path.stat().st_size} log bytes",
                                flush=True,
                            )
                            heartbeat = time.monotonic() + 15
                        time.sleep(0.5)
                finally:
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=10)
            if child.returncode:
                raise RuntimeError(f"{log}: exit {child.returncode}; evidence retained")

        call(["image", "inspect", IMAGE, "--format", "{{.Id}}"], "tooling.log")
        if (output / "tooling.log").read_text().strip() != IMAGE_ID:
            raise ValueError("local VM tooling changed")
        call(["volume", "inspect", CACHE], "cache.json")
        call(
            ["volume", "create", "--label", "image.application=" + name, name],
            "volume.log",
        )
        common = [
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--mount",
            f"type=volume,source={name},target=/vm",
        ]
        guest = name + "-vm"
        try:
            copy = f"""import hashlib, shutil
from pathlib import Path
source, target = Path('/cache'), Path('/vm')
assert source.joinpath('fixture-vm-v1').read_text() == 'disposable image acceptance only\\n'
assert not any(target.iterdir()) and shutil.disk_usage(target).free >= 8 * 1024**3
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
assert sha(source / {BASE!r}) == {BASE_SHA!r}
with (source / {BASE!r}).open('rb') as src, (target / {BASE!r}).open('xb') as dst:
    shutil.copyfileobj(src, dst, 1024**2)
assert sha(target / {BASE!r}) == {BASE_SHA!r}
with (target / 'fixture-vm-v1').open('x') as marker:
    marker.write('disposable image acceptance only\\n')
print('verified RO base; new overlay/seed required')
"""
            call(
                [
                    "run",
                    "--rm",
                    *common,
                    "--memory",
                    "128m",
                    "--memory-swap",
                    "128m",
                    "--cpus",
                    "1",
                    "--pids-limit",
                    "16",
                    "--mount",
                    f"type=volume,source={CACHE},target=/cache,readonly",
                    IMAGE_ID,
                    "python",
                    "-B",
                    "-c",
                    copy,
                ],
                "prepare.log",
                120,
            )
            mounts = []
            for source in (
                "deploy/image-runner",
                "deploy/shop-api.service",
                "deploy/shop-image-runner@.service",
                "deploy/shop-image-runner-pin@.target",
                "apps/api/data/product-image-production/environment.ts",
            ):
                mounts += [
                    "--mount",
                    f"type=bind,source={snapshot / source},target=/fixture-repo/{source},readonly",
                ]
            if db_artifact is not None:
                mounts += [
                    "--mount",
                    f"type=bind,source={db_artifact},target=/db-input,readonly",
                ]
            call(
                [
                    "create",
                    "--name",
                    guest,
                    *common,
                    "--memory",
                    "3g",
                    "--memory-swap",
                    "3g",
                    "--cpus",
                    "2",
                    "--pids-limit",
                    "128",
                    "--tmpfs",
                    "/tmp:rw,nosuid,nodev,noexec,size=64m",
                    *mounts,
                    "--mount",
                    f"type=bind,source={artifact},target=/artifact-input,readonly",
                    IMAGE_ID,
                    "python",
                    "-B",
                    "/fixture-repo/deploy/image-runner/vm.py",
                    "run",
                    "--application"
                    if len(sys.argv) == 3
                    else "--application-api"
                    if sys.argv[3] == "--api-only"
                    else "--readiness-encode"
                    if sys.argv[3] == "--encode-only"
                    else "--readiness-launcher"
                    if sys.argv[3] == "--launcher-only"
                    else "--readiness-stop"
                    if sys.argv[3] == "--launcher-stop"
                    else "--readiness-db"
                    if sys.argv[3] == "--db-only"
                    else "--application-worker",
                ],
                "create.log",
            )
            call(["inspect", guest], "runtime-isolation.json")
            inspected = json.loads((output / "runtime-isolation.json").read_text())[0]
            policy = inspected["HostConfig"]
            if not (
                policy["NetworkMode"] == "none"
                and policy["ReadonlyRootfs"]
                and not policy["Privileged"]
                and not policy["CapAdd"]
                and policy["CapDrop"] == ["ALL"]
                and "no-new-privileges" in policy["SecurityOpt"]
                and policy["Memory"] == 3 * 1024**3
                and policy["MemorySwap"] == policy["Memory"]
                and policy["NanoCpus"] == 2 * 10**9
                and policy["PidsLimit"] == 128
                and not policy["Devices"]
                and not policy["PidMode"]
                and all(
                    not item["RW"]
                    for item in inspected["Mounts"]
                    if item["Type"] == "bind"
                )
            ):
                raise ValueError("actual VM container policy mismatch")
            call(["start", "--attach", guest], "result.log", 1230)
        finally:
            # Touch only this turn's unique container/volume. Preserve old caches.
            probe = subprocess.run(
                docker + ["inspect", "--format", "{{.State.Running}}", guest],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            if probe.returncode == 0 and probe.stdout.strip() == "true":
                subprocess.run(
                    docker + ["stop", "--timeout", "3", guest],
                    capture_output=True,
                    timeout=15,
                    check=True,
                )
            if probe.returncode == 0:
                call(["inspect", guest], "runtime-final.json")
                state = json.loads((output / "runtime-final.json").read_text())[0][
                    "State"
                ]
                if state["Running"] or state["Pid"]:
                    raise RuntimeError("owned fixture not quiescent; retained")
                call(["rm", guest], "container-removed.log")
            # Export serial before deleting the new volume. Failure retains it.
            call(
                [
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--read-only",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "--memory",
                    "64m",
                    "--memory-swap",
                    "64m",
                    "--cpus",
                    "0.25",
                    "--pids-limit",
                    "16",
                    "--mount",
                    f"type=volume,source={name},target=/vm,readonly",
                    IMAGE_ID,
                    "cat",
                    "/vm/serial.log",
                ],
                "serial.log",
                30,
            )
            call(["volume", "rm", name], "cleanup.log")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "NOT VERIFIED", "reason": str(error)}), flush=True)
        sys.exit(78)
