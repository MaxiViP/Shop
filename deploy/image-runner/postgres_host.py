"""Export pinned public image bytes, never start PostgreSQL outside the VM."""

import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import struct
import subprocess
import sys
import tarfile
import tempfile
import uuid

REPO = Path(__file__).resolve().parents[2]
IMAGE = (
    "postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af"
)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def elf(data: bytes) -> list[str]:
    if data[:4] != b"\x7fELF":
        return []
    assert data[4:6] == b"\x02\x01" and struct.unpack_from("<H", data, 18)[0] == 62
    offset = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    headers = [
        struct.unpack_from("<IIQQQQQQ", data, offset + index * size)
        for index in range(count)
    ]
    needed = []
    strings = None
    for header in headers:
        if header[0] == 3:
            needed.append(
                data[header[2] : header[2] + header[5]].rstrip(b"\0").decode()
            )
        if header[0] != 2:
            continue
        table = [
            struct.unpack_from("<qQ", data, index)
            for index in range(header[2], header[2] + header[5], 16)
        ]
        string_address = next(value for kind, value in table if kind == 5)
        load = next(
            item
            for item in headers
            if item[0] == 1 and item[3] <= string_address < item[3] + item[5]
        )
        strings = load[2] + string_address - load[3]
        for kind, value in table:
            if kind == 1:
                start = strings + value
                needed.append(data[start : data.index(b"\0", start)].decode())
    return needed


def package(source: Path, target: Path) -> dict[str, object]:
    with tarfile.open(source) as archive:
        members = {item.name.rstrip("/"): item for item in archive.getmembers()}
        assert all(
            not name.startswith("/") and ".." not in PurePosixPath(name).parts
            for name in members
        )

        def resolve(name: str) -> str:
            name = posixpath.normpath(name.lstrip("/"))
            for _ in range(32):
                assert not name.startswith("..")
                parts = name.split("/")
                for index in range(1, len(parts) + 1):
                    prefix = "/".join(parts[:index])
                    item = members.get(prefix)
                    if item and (item.issym() or item.islnk()):
                        link = item.linkname
                        base = (
                            ""
                            if link.startswith("/") or item.islnk()
                            else posixpath.dirname(prefix)
                        )
                        name = posixpath.normpath(
                            posixpath.join(base, link.lstrip("/"), *parts[index:])
                        )
                        break
                else:
                    return name
            raise ValueError("link depth")

        payload: dict[str, tuple[str, bytes, int]] = {}

        def directory(name: str) -> None:
            if not name or name == ".":
                return
            directory(posixpath.dirname(name))
            payload.setdefault(name, ("directory", b"", 0o555))

        def add(path: str) -> None:
            name = (
                posixpath.join(
                    resolve(posixpath.dirname(path)), posixpath.basename(path)
                )
                if "/" in path
                else path
            )
            if name in payload:
                return
            item = members[name]
            directory(posixpath.dirname(name))
            if item.isdir():
                directory(name)
            elif item.issym():
                canonical = resolve(name)
                payload[name] = (
                    "symlink",
                    posixpath.relpath(
                        canonical, posixpath.dirname(name) or "."
                    ).encode(),
                    0o777,
                )
                add(canonical)
            else:
                assert item.isfile() or item.islnk()
                actual = members[resolve(name)]
                assert actual.size <= 64 * 1024**2
                content = archive.extractfile(actual).read()
                payload[name] = (
                    "file",
                    content,
                    0o555 if actual.mode & 0o111 else 0o444,
                )
                for library in elf(content):
                    if library.startswith("/"):
                        add(library.lstrip("/"))
                    else:
                        choices = sorted(
                            candidate
                            for candidate in members
                            if posixpath.basename(candidate) == library
                            and candidate.startswith(("lib/", "usr/lib/"))
                        )
                        candidates = {resolve(candidate) for candidate in choices}
                        assert len(candidates) == 1, (library, candidates)
                        add(choices[0])

        for name in ("bin", "lib", "lib64"):
            if members[name].issym():
                add(name)
        selected = [
            name
            for name, item in members.items()
            if name.startswith(("usr/lib/postgresql/18/", "usr/share/postgresql/18/"))
            and (item.isfile() or item.issym() or item.islnk())
            and "/bitcode/" not in name
            and not posixpath.basename(name).startswith("llvmjit")
        ]
        assert selected
        for name in selected:
            add(name)
        add("usr/bin/sh")
        add("usr/share/zoneinfo/Etc/UTC")
        directory("etc")
        for name, value in {
            "etc/passwd": "root:x:0:0:root:/nonexistent:/nonexistent\nfixture:x:55000:55000:fixture:/nonexistent:/nonexistent\n",
            "etc/group": "root:x:0:\nfixture:x:55000:\n",
            "etc/nsswitch.conf": "passwd: files\ngroup: files\nhosts: files\n",
        }.items():
            payload[name] = ("file", value.encode(), 0o444)
        for name in (
            "data",
            "run",
            "tmp",
            "var/tmp",
            "root",
            "proc",
            "sys",
            "dev",
            "dev/mqueue",
            "dev/hugepages",
            "dev/shm",
            "dev/pts",
            "run/host",
            "run/systemd/journal",
        ):
            directory(name)
        for name in (
            "run/host/os-release",
            "run/host/notify",
            "run/systemd/private",
            "run/systemd/journal/socket",
            "run/systemd/journal/stdout",
            "dev/log",
        ):
            payload[name] = ("file", b"", 0o444)
        directory("usr/share/zoneinfo")
        payload["usr/share/zoneinfo/UTC"] = ("symlink", b"Etc/UTC", 0o777)
        entries = [
            {"path": ".", "uid": 0, "gid": 0, "mode": "0o555", "type": "directory"}
        ]
        with tarfile.open(target, "w") as output:
            root = tarfile.TarInfo("rootfs")
            root.type, root.mode = tarfile.DIRTYPE, 0o555
            output.addfile(root)
            for name, (kind, content, mode) in sorted(payload.items()):
                item = tarfile.TarInfo("rootfs/" + name)
                item.mode = mode
                record = {
                    "path": name,
                    "uid": 0,
                    "gid": 0,
                    "mode": oct(mode),
                    "type": kind,
                }
                if kind == "directory":
                    item.type = tarfile.DIRTYPE
                elif kind == "symlink":
                    item.type, item.linkname = tarfile.SYMTYPE, content.decode()
                    record["target"] = content.decode()
                else:
                    item.size = len(content)
                    record.update(
                        size=len(content), sha256=hashlib.sha256(content).hexdigest()
                    )
                entries.append(record)
                output.addfile(item, io.BytesIO(content) if kind == "file" else None)
    return {
        "format": 1,
        "entries": entries,
        "sourceImage": IMAGE,
        "productionApply": "SANDBOX_UNVERIFIED",
    }


def main() -> None:
    assert os.name == "nt" and sys.argv[1:] == ["--export"]
    folder = REPO / "work" / ("linux-postgres-" + uuid.uuid4().hex)
    folder.mkdir()
    output = folder / "artifact"
    output.mkdir()
    name = folder.name + "-export"
    print("POSTGRES_OUTPUT=" + str(folder), flush=True)
    with tempfile.TemporaryDirectory(prefix="korzina-postgres-export-") as client:
        docker = [
            "docker",
            "--host",
            "npipe:////./pipe/docker_engine",
            "--config",
            client,
        ]
        image = json.loads(
            subprocess.check_output(docker + ["image", "inspect", IMAGE], timeout=20)
        )[0]
        assert IMAGE in image["RepoDigests"]
        (folder / "image.json").write_text(
            json.dumps(
                {"Id": image["Id"], "RepoDigests": image["RepoDigests"]}, indent=2
            )
        )
        try:
            subprocess.run(
                docker
                + [
                    "create",
                    "--name",
                    name,
                    "--label",
                    "image.postgres-export=" + name,
                    "--network",
                    "none",
                    "--read-only",
                    "--cap-drop",
                    "ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "--tmpfs",
                    "/var/lib/postgresql:rw,nosuid,nodev,noexec,size=1m",
                    "--entrypoint",
                    "/bin/false",
                    image["Id"],
                ],
                check=True,
                timeout=20,
                stdin=subprocess.DEVNULL,
                capture_output=True,
            )
            before = json.loads(
                subprocess.check_output(docker + ["inspect", name], timeout=20)
            )[0]
            assert (
                before["State"]["Status"] == "created" and before["State"]["Pid"] == 0
            )
            assert not any(item["Type"] == "volume" for item in before["Mounts"])
            (folder / "container.json").write_text(json.dumps(before, indent=2))
            with (folder / "image.tar").open("xb") as stream:
                subprocess.run(
                    docker + ["export", name],
                    stdout=stream,
                    stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL,
                    timeout=90,
                    check=True,
                )
        finally:
            subprocess.run(
                docker + ["rm", name], timeout=20, check=True, capture_output=True
            )
    manifest = package(folder / "image.tar", output / "rootfs.tar")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    summary = {
        "status": "EXPORTED_NOT_STARTED",
        "sourceImage": IMAGE,
        "sourceImageId": image["Id"],
        "rootfsSha256": digest(output / "rootfs.tar"),
        "manifestSha256": digest(output / "manifest.json"),
        "files": len(manifest["entries"]),
        "productionApply": "SANDBOX_UNVERIFIED",
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
