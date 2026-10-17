"""Actual packaged Node/Sharp + compiled Nest main in a marked offline guest."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).parent))
import artifact
import launcher as runner


def worker() -> None:
    runner.require(
        os.getpid() == 1 and os.geteuid() == 0, "FIXTURE_SUPERVISOR_REQUIRED"
    )
    runner.process_policy(Path("/proc/self/status").read_text())
    mounts = [
        line.split() for line in Path("/proc/self/mountinfo").read_text().splitlines()
    ]
    artifact_mount = max(
        (item for item in mounts if runner.beneath("/artifact/apps/api", item[4])),
        key=lambda item: len(item[4]),
    )
    runner.require("ro" in artifact_mount[5].split(","), "ARTIFACT_MOUNT_NOT_RO")
    group = runner.cgroup_path(Path("/proc/self/cgroup").read_text())
    location = Path("/sys/fs/cgroup") / group.lstrip("/")
    limits = runner.cgroup_policy(
        {
            name: (location / name).read_text()
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
    print("IMAGE_WORKER_LIMITS=" + json.dumps(limits), flush=True)
    result = subprocess.run(
        [
            "/usr/bin/node",
            "--import",
            "tsx",
            "/opt/image-runner/application.mjs",
            "probe",
        ],
        cwd="/artifact/apps/api",
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        # Compound fixture: direct encode + supervised child + separate CLI.
        # The encoder keeps its real 30 s budget; the CLI keeps its real 45 s.
        timeout=180,
        check=False,
        user=55000,
        group=55000,
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
    if result.returncode or result.stderr:
        raise RuntimeError(
            f"Node fixture exit {result.returncode}: {result.stderr[:8192]}"
        )


def command(*args: str) -> str:
    return subprocess.check_output(
        list(args), text=True, stderr=subprocess.STDOUT, timeout=40
    )


def logs(unit: str) -> str:
    return command("journalctl", "--unit", unit, "--no-pager", "-o", "cat")


def fingerprint(root: Path) -> dict[str, object]:
    return {
        p.relative_to(root).as_posix(): {
            "bytes": p.read_bytes().hex(),
            "inode": p.stat().st_ino,
            "device": p.stat().st_dev,
            "mode": p.stat().st_mode,
            "uid": p.stat().st_uid,
            "gid": p.stat().st_gid,
            "mtime": p.stat().st_mtime_ns,
            "ctime": p.stat().st_ctime_ns,
        }
        for p in root.rglob("*")
        if p.is_file()
    }


def run(scope: str = "application") -> None:
    import pwd

    marker = Path("/etc/image-acceptance-disposable")
    assert marker.read_text() == "isolated-image-fixtures-v1\n"
    media = Path("/mnt/image-artifact")
    media.mkdir()
    command(
        "mount",
        "-t",
        "iso9660",
        "-o",
        "ro,nosuid,nodev,noexec",
        "/dev/disk/by-label/IMAGE_RUNTIME",
        str(media),
    )
    summary = json.loads((media / "summary.json").read_text())
    assert artifact.sha(media / "rootfs.tar") == summary["rootfsSha256"]
    assert artifact.sha(media / "manifest.json") == summary["manifestSha256"]
    manifest = json.loads((media / "manifest.json").read_text())
    root = Path(tempfile.mkdtemp(prefix="image-application-fixture-", dir="/var/tmp"))
    root.chmod(0o755)
    with tarfile.open(media / "rootfs.tar") as archive:
        names = set()
        for member in archive.getmembers():
            name = Path(member.name)
            assert (
                not name.is_absolute()
                and ".." not in name.parts
                and name.parts[0] == "rootfs"
            )
            assert (
                member.name not in names
                and not member.islnk()
                and (member.isfile() or member.isdir() or member.issym())
            )
            names.add(member.name)
            if member.issym():
                assert not Path(member.linkname).is_absolute()
        archive.extractall(root, filter="data")
    # Python's data filter intentionally omits directory modes. Restore only the
    # enumerated, non-writable modes before verifying the complete extracted tree.
    for item in manifest["entries"]:
        if item["type"] == "symlink":
            continue
        path = root / "rootfs" / item["path"]
        mode = int(item["mode"], 8)
        assert mode in (0o444, 0o555) and not path.is_symlink()
        assert path.resolve(strict=True).is_relative_to(root / "rootfs")
        path.chmod(mode)
    artifact.verify(root / "rootfs", manifest)
    print(
        "IMAGE_ARTIFACT_VERIFIED="
        + json.dumps({"summary": summary, "entries": len(manifest["entries"])}),
        flush=True,
    )
    if scope == "readiness-production":
        import production_fixture
        production_fixture.run(root, manifest)
        return
    if scope == "readiness-encode":
        import readiness

        readiness.run(root, manifest, scope)
        return
    if scope in ("readiness-launcher", "readiness-stop"):
        import launcher_fixture

        launcher_fixture.run(root, manifest, scope == "readiness-stop")
        return
    if scope == "readiness-db":
        import db_fixture

        db_fixture.run(root, manifest)
        return
    try:
        account = pwd.getpwuid(55000)
        assert account.pw_name == "imagefixture" and account.pw_gid == 55000
    except KeyError:
        command(
            "useradd",
            "--uid",
            "55000",
            "--user-group",
            "--no-create-home",
            "--shell",
            "/usr/sbin/nologin",
            "imagefixture",
        )
    storage = root / "storage"
    storage.mkdir(mode=0o755)
    for name in ("products", "chat", "product-variants", ".product-image-state"):
        path = storage / name
        path.mkdir(mode=0o700)
        os.chown(path, 55000, 55000)
        file = path / ("original.png" if name == "products" else "private")
        file.write_bytes(b"new disposable sentinel only\n")
        file.chmod(0o600)
        os.chown(file, 55000, 55000)
    before = fingerprint(storage)
    (root / "input").mkdir(mode=0o755)
    for name in ("request.json", "inventory.jsonl", "approval.json"):
        (root / "input" / name).write_text("{}\n")
    (root / "deploy.lock").write_text("disposable fixture\n")
    units: list[Path] = []
    try:
        from test_systemd import group_quiescent

        assert scope in ("application", "application-api", "application-worker")
        repo = Path(__file__).resolve().parents[2]
        token = uuid.uuid4().hex
        node = None
        if scope != "application-api":
            # Retain all existing worker sandbox/resource directives. Replace only
            # fixture paths/entrypoint, as in the accepted namespace harness.
            from test_namespace import render

            service = Path("/run/systemd/system") / (
                "image-application-worker-" + token + ".service"
            )
            pin = service.with_suffix(".target")
            body = render(
                (repo / "deploy/shop-image-runner@.service").read_text(),
                root,
                service,
                pin,
                "node",
            )
            body = (
                "\n".join(
                    "ExecStart=/usr/bin/python3 -I -B /opt/image-runner/application.py worker"
                    if line.startswith("ExecStart=")
                    else "RuntimeMaxSec=200"
                    if line.startswith("RuntimeMaxSec=")
                    else line
                    for line in body.splitlines()
                )
                + "\n"
            )
            service.write_text(body)
            pin.write_text("[Unit]\nDescription=Disposable fixture only\n")
            units += [service, pin]
            command("systemctl", "daemon-reload")
            command("systemctl", "start", service.name)
            worker_group = runner.show(service.name)["ControlGroup"]
            assert worker_group
            deadline = time.monotonic() + 215
            while (
                runner.show(service.name)["ActiveState"] in ("active", "activating")
                and time.monotonic() < deadline
            ):
                time.sleep(0.2)
            state = runner.show(service.name)
            worker_logs = logs(service.name)
            print("IMAGE_WORKER_LOG=" + worker_logs, flush=True)
            assert (
                state["ActiveState"] == "inactive" and state["Result"] == "success"
            ), {
                key: state[key]
                for key in (
                    "ActiveState",
                    "Result",
                    "MainPID",
                    "ExecMainCode",
                    "ExecMainStatus",
                )
            }
            assert group_quiescent(
                Path("/sys/fs/cgroup") / worker_group.lstrip("/"), state["ActiveState"]
            )
            reports = [
                json.loads(line.split("=", 1)[1])
                for line in worker_logs.splitlines()
                if line.startswith("IMAGE_NODE_RESULT=")
            ]
            assert len(reports) == 1
            node = reports[0]
            assert node["versions"] == manifest["versions"] and node["identity"][
                "uids"
            ] == [55000, 55000]
            assert node["identity"]["groups"] == [55000] and node["identity"]["pid"] > 1
            status = dict(
                line.split(":", 1)
                for line in node["identity"]["status"].splitlines()
                if ":" in line
            )
            assert all(
                int(status[key].strip(), 16) == 0
                for key in ("CapEff", "CapPrm", "CapInh", "CapAmb")
            )
            assert (
                status["NoNewPrivs"].strip() == "1" and status["Seccomp"].strip() == "2"
            )
            assert status["Groups"].strip() == ""
            assert int(status["CapBnd"].strip(), 16) == 0xE4
            expected = {
                item["path"]: item
                for item in manifest["entries"]
                if item["type"] == "file"
            }
            for item in node["mapped"]:
                assert expected[item["path"].lstrip("/")]["sha256"] == item["sha256"]
            assert any(item["path"].endswith(".node") for item in node["mapped"])
            assert any("libvips" in item["path"] for item in node["mapped"])
            assert fingerprint(storage) == before
            artifact.verify(root / "rootfs", manifest)
            print(
                "IMAGE_WORKER_RESULT="
                + json.dumps(
                    {
                        "worker": node,
                        "cgroupQuiescent": True,
                        "artifactUnchanged": True,
                        "syntheticStorageUnchanged": True,
                        "productionApply": "SANDBOX_UNVERIFIED",
                    }
                ),
                flush=True,
            )
            if scope == "application-worker":
                return
        api = Path("/run/systemd/system") / (
            "image-application-api-" + token + ".service"
        )
        replacements = {
            "User": "imagefixture",
            "Group": "imagefixture",
            "WorkingDirectory": "/artifact/apps/api",
            "ExecStart": "/usr/bin/node --import /opt/image-runner/application.mjs /artifact/apps/api/dist/main.js",
            "Restart": "no",
            "ReadWritePaths": "+/storage",
            "InaccessiblePaths": "+/runner",
        }
        lines = []
        for line in (repo / "deploy/shop-api.service").read_text().splitlines():
            if (
                line.startswith(("Wants=", "After=", "EnvironmentFile=", "#"))
                or line == "[Install]"
                or line.startswith("WantedBy=")
            ):
                continue
            key = line.split("=", 1)[0]
            if key in replacements:
                line = key + "=" + replacements[key]
            elif key == "ReadOnlyPaths":
                # This fixture adds RootDirectory; '+' keeps the API rules inside
                # that root instead of resolving host paths before the bind mount.
                line = line.replace("/var/lib/korzinamarket/uploads", "+/storage")
            lines.append(line)
        # Packaging scaffolding only; app policy remains the current API unit.
        lines += [
            f"RootDirectory={root}/rootfs",
            "MountAPIVFS=yes",
            f"BindPaths={storage}:/storage",
            "Environment=PATH=/usr/bin:/bin LANG=C.UTF-8 NODE_ENV=production PORT=4001 UPLOAD_DIR=/storage/products AUTH_SECRET=image-application-disposable",
            "UnsetEnvironment=DATABASE_URL NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH",
        ]
        api.write_text("\n".join(lines) + "\n")
        units.append(api)
        command("systemctl", "daemon-reload")
        command("systemctl", "start", api.name)
        api_state = runner.show(api.name)
        main_pid = int(api_state["MainPID"])
        api_group = Path("/sys/fs/cgroup") / api_state["ControlGroup"].lstrip("/")
        assert main_pid > 1
        # Private network is absent in the API profile; this VM has no NIC.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 45
        health = None
        while time.monotonic() < deadline:
            try:
                with opener.open(
                    "http://127.0.0.1:4001/api/health", timeout=1
                ) as response:
                    health = json.load(response)
                break
            except (OSError, urllib.error.URLError):
                if runner.show(api.name)["ActiveState"] != "active":
                    break
                time.sleep(0.2)
        print("IMAGE_API_START_LOG=" + logs(api.name), flush=True)
        assert health == {"ok": True}, runner.show(api.name)
        try:
            opener.open("http://127.0.0.1:4001/api/health/ready", timeout=5)
            raise AssertionError("DB-free fixture must not report database readiness")
        except urllib.error.HTTPError as error:
            assert error.code == 503 and json.load(error) == {
                "ok": False,
                "database": False,
            }
        started = time.monotonic()
        command("systemctl", "stop", api.name)
        elapsed = time.monotonic() - started
        final = runner.show(api.name)
        api_logs = logs(api.name)
        print("IMAGE_API_STOP_LOG=" + api_logs, flush=True)
        assert (
            "API_FIXTURE_DESTROY" in api_logs
            and "API_FIXTURE_SHUTDOWN=SIGTERM" in api_logs
        ), "Nest shutdown hooks were not called"
        assert (
            final["MainPID"] == "0"
            and final["ActiveState"] == "inactive"
            and final["Result"] == "success"
        ), final
        assert elapsed < 30 and not Path(f"/proc/{main_pid}").exists()
        assert group_quiescent(api_group, final["ActiveState"])
        assert fingerprint(storage) == before
        artifact.verify(root / "rootfs", manifest)
        print(
            "IMAGE_APPLICATION_RESULT="
            + json.dumps(
                {
                    "worker": node,
                    "api": {
                        "health": health,
                        "ready": 503,
                        "pidInNamespace": 1,
                        "shutdownSignal": "SIGTERM",
                        "stopSeconds": elapsed,
                        "state": {
                            key: final[key]
                            for key in (
                                "ActiveState",
                                "Result",
                                "MainPID",
                                "ExecMainCode",
                                "ExecMainStatus",
                            )
                        },
                        "cgroupQuiescent": True,
                    },
                    "artifactUnchanged": True,
                    "syntheticStorageUnchanged": True,
                    "database": "provider replaced; no connection",
                    "productionApply": "SANDBOX_UNVERIFIED",
                }
            ),
            flush=True,
        )
    finally:
        for unit in reversed(units):
            if unit.suffix == ".service":
                command("systemctl", "stop", unit.name)
                state = runner.show(unit.name)
                assert state["MainPID"] == "0" and state["ActiveState"] in (
                    "inactive",
                    "failed",
                )
                print(
                    "IMAGE_UNIT_FINAL="
                    + json.dumps(
                        {
                            "unit": unit.name,
                            "state": {
                                key: state[key]
                                for key in (
                                    "ActiveState",
                                    "Result",
                                    "MainPID",
                                    "ExecMainCode",
                                    "ExecMainStatus",
                                )
                            },
                        }
                    ),
                    flush=True,
                )
        # Preserve the new guest-only fixture through shutdown; serial is exported
        # before its owned VM volume is removed. No source/cache tree is cleaned.


if __name__ == "__main__":
    if sys.argv[1:] == ["worker"]:
        worker()
    else:
        sys.exit("Only the fixed disposable worker entrypoint is supported")
