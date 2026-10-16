"""Build/verify an enumerated Linux runtime. No production installation or apply."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import sysconfig
import tarfile

SOURCE = Path("/source")
ROOT = Path("/runtime")
OUT = Path("/out")
BASE = "node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa"


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def entries(root: Path) -> list[dict[str, object]]:
    result = []
    for path in [root, *sorted(root.rglob("*"))]:
        info = path.lstat()
        name = path.relative_to(root).as_posix()
        if (
            info.st_uid
            or info.st_gid
            or (not path.is_symlink() and info.st_mode & 0o6022)
            or os.listxattr(path, follow_symlinks=False)
        ):
            raise ValueError(f"unsafe owner/mode/xattr: {name}")
        item: dict[str, object] = {
            "path": name,
            "uid": info.st_uid,
            "gid": info.st_gid,
            "mode": oct(stat.S_IMODE(info.st_mode)),
        }
        if path.is_symlink():
            # Symlinks have 0777 on Linux; their target and ancestors must be inside.
            target = os.readlink(path)
            if target.startswith("/") or not path.resolve(strict=True).is_relative_to(
                root
            ):
                raise ValueError(f"escaping symlink: {name}")
            item.update(type="symlink", target=target)
        elif path.is_dir():
            item["type"] = "directory"
        elif path.is_file() and info.st_nlink == 1:
            item.update(type="file", size=info.st_size, sha256=sha(path))
        else:
            raise ValueError(f"special/hardlinked file: {name}")
        if path.name.startswith(".env") or path.name in (
            "shadow",
            "config.json",
            ".npmrc",
            ".pnpmrc",
        ):
            raise ValueError(f"credential-like file: {name}")
        result.append(item)
    return result


def verify(root: Path, manifest: dict[str, object]) -> None:
    if manifest.get("productionApply") != "SANDBOX_UNVERIFIED":
        raise ValueError("artifact tree/metadata mismatch")
    actual = entries(root)
    if actual != manifest["entries"]:
        expected = {item["path"]: item for item in manifest["entries"]}
        observed = {item["path"]: item for item in actual}
        changed = [
            {"path": name, "expected": expected.get(name), "actual": observed.get(name)}
            for name in sorted(set(expected) | set(observed))
            if expected.get(name) != observed.get(name)
        ]
        raise ValueError("artifact tree/metadata mismatch: " + json.dumps(changed[:16]))


def build() -> None:
    if ROOT.exists() or OUT.exists():
        raise ValueError("new build directories required")
    ROOT.mkdir()
    OUT.mkdir()
    # Preserve the pinned base's /usr merge so library aliases retain their target.
    for name in ("lib", "lib64", "bin"):
        original = Path("/") / name
        if original.is_symlink():
            (ROOT / os.readlink(original)).mkdir(parents=True, exist_ok=True)
            (ROOT / name).symlink_to(os.readlink(original))

    def copy(path: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink():
            link = os.readlink(path)
            if link.startswith("/"):
                # Runtime libraries use absolute aliases on some distributions.
                link = os.path.relpath(ROOT / link.lstrip("/"), target.parent)
            target.symlink_to(link)
            resolved = path.resolve(strict=True)
            destination = ROOT / str(resolved).lstrip("/")
            if not destination.exists():
                copy(resolved, destination)
        else:
            shutil.copyfile(path, target)
            target.chmod(stat.S_IMODE(path.stat().st_mode) & 0o777)

    copied: set[Path] = set()

    def package(path: Path) -> None:
        if path in copied:
            return
        copied.add(path)
        if not path.is_relative_to(SOURCE):
            raise ValueError("dependency escaped source")
        target = ROOT / "artifact" / path.relative_to(SOURCE)
        if path.is_symlink():
            link = os.readlink(path)
            if link.startswith("/") or not path.resolve(strict=True).is_relative_to(
                SOURCE
            ):
                raise ValueError("external dependency link")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(link)
            package(path.resolve(strict=True))
            # Follow declared runtime requirements, not every pnpm peer link.
            # Optional CLI/compiler peers of @prisma/client are build inputs.
            parent = path.resolve(strict=True).parent
            if parent.name.startswith("@"):
                parent = parent.parent
            metadata = json.loads(
                (path.resolve(strict=True) / "package.json").read_text()
            )
            requirements = set(metadata.get("dependencies", {})) | set(
                metadata.get("optionalDependencies", {})
            )
            for name in metadata.get("peerDependencies", {}):
                optional = (
                    metadata.get("peerDependenciesMeta", {})
                    .get(name, {})
                    .get("optional", False)
                )
                if not optional or name in dependencies:
                    requirements.add(name)
            for name in sorted(requirements):
                sibling = parent / name
                if sibling.is_symlink():
                    package(sibling)
        elif path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            for child in path.iterdir():
                package(child)
        elif path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            target.chmod(stat.S_IMODE(path.stat().st_mode) & 0o777)
        else:
            raise ValueError("special dependency file")

    api = SOURCE / "apps/api"
    dependencies = json.loads((api / "package.json").read_text())["dependencies"]
    for name in [*dependencies, "tsx"]:
        package(api / "node_modules" / name)
    selected = [
        SOURCE / "package.json",
        SOURCE / "pnpm-lock.yaml",
        api / "package.json",
    ]
    selected += list((api / "dist").rglob("*.js"))
    for folder in ("product-image-production", "product-image-variants"):
        selected += [
            p
            for p in (api / "data" / folder).glob("*.ts")
            if not p.name.endswith(".spec.ts")
        ]
    selected += [
        api / "src/product" / name
        for name in ("image-storage.ts", "image-manifest.ts", "image-variants.ts")
    ]
    for path in selected:
        package(path)
    for name in ("launcher.py", "application.py", "application.mjs", "artifact.py"):
        copy(SOURCE / "deploy/image-runner" / name, ROOT / "opt/image-runner" / name)

    python = Path("/usr/bin/python3")
    copy(python, ROOT / "usr/bin/python3")
    stdlib = Path(sysconfig.get_path("stdlib"))
    shutil.copytree(
        stdlib,
        ROOT / str(stdlib).lstrip("/"),
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
    copy(Path("/usr/local/bin/node"), ROOT / "usr/bin/node")
    copy(Path("/usr/bin/systemctl"), ROOT / "usr/bin/systemctl")
    native = [
        ROOT / "usr/bin/node",
        (ROOT / "usr/bin/python3").resolve(strict=True),
        ROOT / "usr/bin/systemctl",
    ]
    native += (
        list(ROOT.rglob("*.node"))
        + list(ROOT.rglob("*.so"))
        + list(ROOT.rglob("*.so.*"))
    )
    library_paths: set[Path] = set()
    for path in native:
        if path.is_symlink() or path.read_bytes()[:4] != b"\x7fELF":
            continue
        # Run ldd only on pinned/lockfile-installed build inputs.
        result = subprocess.run(
            ["ldd", str(path)], capture_output=True, text=True, timeout=15, check=False
        )
        if result.returncode or "not found" in result.stdout:
            raise ValueError(
                f"unresolved native closure: {path}: {result.stdout} {result.stderr}"
            )
        for match in re.findall(r"(/[\w.+/-]+)", result.stdout):
            library = Path(match)
            if library.is_file() and not library.is_relative_to(ROOT):
                library_paths.add(library)
    for path in sorted(library_paths):
        target = ROOT / str(path).lstrip("/")
        if not target.exists():
            copy(path, target)
    for folder in (
        "etc",
        "root",
        "storage/products",
        "storage/chat",
        "storage/product-variants",
        "storage/.product-image-state",
        "input",
        "control",
        "run",
        "tmp",
        "var/tmp",
        "proc",
        "proc/sys/fs/binfmt_misc",
        "sys",
        "dev/mqueue",
        "dev/hugepages",
        "dev/shm",
        "dev/pts",
        "runner",
    ):
        (ROOT / folder).mkdir(parents=True, exist_ok=True)
    # systemd prepares bind destinations as root before installing its RO view.
    # Enumerate placeholders now so namespace setup cannot extend the rootfs.
    for name in (
        "input/request.json",
        "input/inventory.jsonl",
        "input/approval.json",
        "control/deploy.lock",
        "control/runner.service",
        "control/pin.target",
        "run/host/os-release",
        "run/host/notify",
        "run/systemd/private",
        "run/systemd/journal/socket",
        "run/systemd/journal/stdout",
        "dev/log",
    ):
        path = ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=False)
    (ROOT / "etc/passwd").write_text(
        "root:x:0:0:root:/nonexistent:/nonexistent\nimagefixture:x:55000:55000:fixture:/nonexistent:/nonexistent\n"
    )
    (ROOT / "etc/group").write_text("root:x:0:\nimagefixture:x:55000:\n")
    (ROOT / "etc/nsswitch.conf").write_text(
        "passwd: files\ngroup: files\nhosts: files\n"
    )
    for path in [*ROOT.rglob("*"), ROOT]:
        if not path.is_symlink():
            path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
    # Check each executable, including the resolved Python ELF, with this closure.
    for executable in (
        [
            "/usr/bin/python3",
            "-I",
            "-B",
            "-c",
            "import runpy; runpy.run_path('/opt/image-runner/application.py', run_name='fixture_selfcheck')",
        ],
        ["/usr/bin/systemctl", "--version"],
    ):
        subprocess.run(
            ["chroot", str(ROOT), *executable],
            check=True,
            timeout=30,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
        )
    # Execute with this loader/library closure, without host /etc or node_modules.
    check = subprocess.run(
        [
            "chroot",
            str(ROOT),
            "/usr/bin/node",
            "/opt/image-runner/application.mjs",
            "version",
        ],
        cwd=ROOT / "artifact/apps/api",
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if check.returncode:
        raise ValueError(f"isolated runtime self-check: {check.stderr}")
    versions = json.loads(check.stdout)
    manifest = {
        "format": 1,
        "scope": "disposable Linux artifact; target NOT VERIFIED",
        "productionApply": "SANDBOX_UNVERIFIED",
        "base": BASE,
        "source": json.loads((SOURCE / "source.json").read_text()),
        "versions": versions,
        "entries": entries(ROOT),
        "packages": subprocess.check_output(
            ["dpkg-query", "-W", "-f=${Package}\t${Version}\n"], text=True
        ).splitlines(),
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=2) + "\n"
    )
    verify(ROOT, manifest)
    with tarfile.open(OUT / "rootfs.tar", "x") as archive:
        archive.add(ROOT, arcname="rootfs", recursive=True)
    shutil.copyfile(SOURCE / "linux-tests.json", OUT / "linux-tests.json")
    summary = {
        "status": "BUILT",
        "productionApply": "SANDBOX_UNVERIFIED",
        "files": len(manifest["entries"]),
        "rootfsSha256": sha(OUT / "rootfs.tar"),
        "manifestSha256": sha(OUT / "manifest.json"),
        "versions": versions,
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    if (
        sys.platform != "linux"
        or sys.argv[1:] != ["build"]
        or SOURCE.resolve() != SOURCE
    ):
        sys.exit("Only a disposable Linux artifact build is supported")
    build()
