"""Local artifact build with whitelisted sources, bounded logs and no credentials."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[2]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    if sys.argv[1:] != ["--build"]:
        raise ValueError("fixed local --build only")
    output = REPO / "work" / ("linux-artifact-" + uuid.uuid4().hex)
    output.mkdir(exist_ok=False)
    context = output / "source"
    context.mkdir()
    tracked = (
        subprocess.check_output(["git", "ls-files", "-z"], cwd=REPO)
        .decode()
        .split("\0")
    )
    sources = [
        name
        for name in tracked
        if name
        and (
            name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml")
            or name.startswith(
                (
                    "apps/api/src/",
                    "apps/api/test/fixtures/",
                    "apps/api/data/product-image-",
                )
            )
            or name
            in (
                "apps/api/package.json",
                "apps/api/tsconfig.json",
                "apps/api/tsconfig.build.json",
                "apps/api/tsconfig.catalog.json",
                "apps/api/vitest.config.ts",
                "apps/api/prisma7.config.ts",
                "apps/api/prisma/schema.prisma",
                "apps/api/nest-cli.json",
            )
        )
    ]
    sources += [
        "deploy/image-runner/" + name
        for name in (
            "Dockerfile.artifact",
            "artifact.py",
            "artifact_test.py",
            "application.py",
            "application.mjs",
            "launcher.py",
            "broker.py",
            "prepare.py",
        )
    ]
    hashes = {}
    for name in sorted(set(sources)):
        source = REPO / name
        if (
            source.is_symlink()
            or not source.is_file()
            or source.stat().st_size > 4 * 1024**2
            or source.name.startswith(".env")
        ):
            raise ValueError("unsafe source: " + name)
        target = context / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        hashes[name] = digest(target)
    head = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=REPO, text=True
    ).strip()
    provenance = {
        "head": head,
        "sources": hashes,
        "productionApply": "requires-launcher-admission",
    }
    (context / "source.json").write_text(json.dumps(provenance, indent=2) + "\n")
    (output / "source.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"ARTIFACT_OUTPUT={output}", flush=True)
    with tempfile.TemporaryDirectory(prefix="korzina-artifact-client-") as client:
        docker = [
            "docker",
            "--host",
            "npipe:////./pipe/docker_engine" if os.name == "nt" else "unix:///var/run/docker.sock",
            "--config",
            client,
        ]
        args = docker + [
            "build",
            "--platform",
            "linux/amd64",
            "--progress",
            "plain",
            "--file",
            str(context / "deploy/image-runner/Dockerfile.artifact"),
            "--output",
            "type=local,dest=" + str(output / "artifact"),
            str(context),
        ]
        with (output / "build.log").open("x", encoding="utf-8") as log:
            child = subprocess.Popen(
                args, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL
            )
            deadline = time.monotonic() + 900
            try:
                while child.poll() is None:
                    if (
                        time.monotonic() > deadline
                        or (output / "build.log").stat().st_size > 8 * 1024**2
                    ):
                        raise RuntimeError("bounded artifact build limit")
                    print(
                        "Artifact build running; log bytes="
                        + str((output / "build.log").stat().st_size),
                        flush=True,
                    )
                    time.sleep(15)
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=15)
        receipt = {
            "exitCode": child.returncode,
            "logSha256": digest(output / "build.log"),
            "sourceManifestSha256": digest(output / "source.json"),
            "productionApply": "requires-launcher-admission",
        }
        (output / "build.json").write_text(json.dumps(receipt, indent=2) + "\n")
        if child.returncode:
            raise RuntimeError(f"artifact build failed; preserved {output}")
        print((output / "artifact/summary.json").read_text(), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "NOT VERIFIED", "reason": str(error)}), flush=True)
        sys.exit(78)
