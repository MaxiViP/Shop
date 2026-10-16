"""Local Docker -> bounded networkless disposable QEMU VM. No host root actions.

Works on Windows Docker Desktop and disposable Linux CI. Only fixed test selectors;
no arbitrary CLI overrides, remote Docker contexts, auth config, privileged
container, host cgroups or KVM devices.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

IMAGE = "korzina-image-acceptance-tools:5b2b"
REPO = Path(__file__).resolve().parents[2]


def main(scope: str = "full") -> int:
    if scope not in (
        "full",
        "child-oom",
        "lifecycle",
        "namespace-positive",
        "security",
    ):
        raise ValueError("unknown fixture scope")
    name = "image-acceptance-" + uuid.uuid4().hex
    output = REPO / "work" / name
    output.mkdir(parents=True, exist_ok=False)
    endpoint = (
        "npipe:////./pipe/docker_engine"
        if os.name == "nt"
        else "unix:///var/run/docker.sock"
    )
    with tempfile.TemporaryDirectory(prefix="image-acceptance-client-") as client:
        docker = ["docker", "--host", endpoint, "--config", client]

        def call(
            args: list[str], timeout: int, log: str
        ) -> subprocess.CompletedProcess[str]:
            with (output / log).open("x", encoding="utf-8") as handle:
                result = subprocess.run(
                    docker + args,
                    stdin=subprocess.DEVNULL,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    timeout=timeout,
                    text=True,
                    check=False,
                )
            if result.returncode:
                raise RuntimeError(f"{log}: exit {result.returncode}; NOT VERIFIED")
            return result

        call(["info", "--format", "{{.OSType}} {{.Architecture}}"], 15, "docker.log")
        if (output / "docker.log").read_text().strip() not in (
            "linux x86_64",
            "linux amd64",
        ):
            raise RuntimeError("local Linux amd64 Docker required; NOT VERIFIED")
        call(
            [
                "build",
                "--file",
                str(REPO / "deploy/image-runner/Dockerfile.acceptance"),
                "--tag",
                IMAGE,
                str(REPO / "deploy/image-runner"),
            ],
            600,
            "build.log",
        )
        call(
            ["volume", "create", "--label", f"image.acceptance={name}", name],
            15,
            "volume.log",
        )
        common = [
            "run",
            "--rm",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--mount",
            f"type=volume,source={name},target=/vm",
        ]
        prepared, guest = name + "-prepare", name + "-vm"
        try:
            print(
                f"Preparing verified Ubuntu fixture image; reports: {output}",
                flush=True,
            )
            call(
                common
                + [
                    "--name",
                    prepared,
                    "--memory",
                    "256m",
                    "--memory-swap",
                    "256m",
                    "--cpus",
                    "0.5",
                    "--pids-limit",
                    "32",
                    "--tmpfs",
                    "/tmp:rw,nosuid,nodev,noexec,size=16m",
                    "--mount",
                    f"type=bind,source={REPO / 'deploy/image-runner/vm.py'},target=/vm-driver.py,readonly",
                    IMAGE,
                    "python",
                    "-B",
                    "/vm-driver.py",
                    "prepare",
                ],
                630,
                "prepare.log",
            )
            sources = [
                "deploy/image-runner",
                "deploy/shop-api.service",
                "deploy/shop-image-runner@.service",
                "deploy/shop-image-runner-pin@.target",
                "apps/api/data/product-image-production/environment.ts",
            ]
            mounts: list[str] = []
            for source in sources:
                mounts += [
                    "--mount",
                    f"type=bind,source={REPO / source},target=/fixture-repo/{source},readonly",
                ]
            print(
                "Booting bounded networkless VM; actual systemd preflight is mandatory",
                flush=True,
            )
            call(
                common
                + [
                    "--network",
                    "none",
                    "--name",
                    guest,
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
                    IMAGE,
                    "python",
                    "-B",
                    "/fixture-repo/deploy/image-runner/vm.py",
                    "run",
                    *([] if scope == "full" else ["--" + scope]),
                ],
                1230,
                "result.log",
            )
            return 0
        finally:
            # Killing this known VM cannot affect host units. Preserve volume unless
            # both exact fixture containers are absent and logs were exported.
            for container in (prepared, guest):
                subprocess.run(
                    docker + ["stop", "--timeout", "3", container],
                    capture_output=True,
                    timeout=15,
                    check=False,
                )
            observations = [
                subprocess.run(
                    docker
                    + [
                        "ps",
                        "--all",
                        "--format",
                        "{{.Names}}",
                        "--filter",
                        f"name=^/{container}$",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                for container in (prepared, guest)
            ]
            absent = all(
                item.returncode == 0 and not item.stdout.strip()
                for item in observations
            )
            if absent:
                with (output / "serial.log").open("x", encoding="utf-8") as handle:
                    exported = subprocess.run(
                        docker
                        + [
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
                            IMAGE,
                            "cat",
                            "/vm/serial.log",
                        ],
                        stdout=handle,
                        stderr=subprocess.STDOUT,
                        timeout=15,
                        check=False,
                    )
                if exported.returncode == 0:
                    call(["volume", "rm", name], 15, "cleanup.log")
                else:
                    print(
                        f"Retained owned fixture volume {name}; serial export unavailable",
                        flush=True,
                    )
            else:
                print(
                    f"NOT VERIFIED: retained fixture containers/volume {name}",
                    flush=True,
                )


if __name__ == "__main__":
    if len(sys.argv) > 2 or (
        len(sys.argv) == 2
        and sys.argv[1]
        not in ("--child-oom", "--lifecycle", "--namespace-positive", "--security")
    ):
        sys.exit("Only fixed fixture selectors are accepted")
    try:
        sys.exit(main(sys.argv[1][2:] if len(sys.argv) == 2 else "full"))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "NOT VERIFIED", "reason": str(error)}), flush=True)
        sys.exit(78)
