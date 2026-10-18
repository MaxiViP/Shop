"""Real PostgreSQL and Prisma pool only in a new networkless marked VM."""

import json
import os
from pathlib import Path
import tarfile
import tempfile
import time
import uuid
import unittest

import application
import artifact
import launcher
from launcher_fixture import wait_done
from test_systemd import group_quiescent

PG = "/usr/lib/postgresql/18/bin/"
SOCKET = "/run/korzina-db-fixture"


def unit(
    root: Path, name: str, executable: str, binds: list[str], writable: str = ""
) -> Path:
    path = Path("/run/systemd/system", name)
    body = f"""[Unit]
Description=Disposable real DB pool lifecycle
[Service]
Type=exec
User=55000
Group=55000
RootDirectory={root}
WorkingDirectory=/
ExecStart={executable}
Environment=PATH=/usr/bin:/bin LANG=C.UTF-8 NODE_ENV=production
UnsetEnvironment=DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DOTENV_CONFIG_PATH
UMask=0077
Restart=no
RuntimeMaxSec=180
TimeoutStopSec=30
KillMode=control-group
OOMPolicy=kill
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivatePIDs=yes
PrivateUsers=full
PrivateNetwork=yes
PrivateDevices=yes
PrivateIPC=yes
PrivateMounts=yes
ProtectSystem=strict
ProtectHome=yes
ProtectControlGroups=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=~@mount @reboot @swap @module @raw-io @clock @debug
MountAPIVFS=yes
TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=64M,mode=1777 /run:rw,nosuid,nodev,noexec,size=8M,mode=0755
MemoryHigh=384M
MemoryMax=512M
MemorySwapMax=0
CPUQuota=50%
TasksMax=64
LimitNOFILE=256
LimitCORE=0
StandardInput=null
StandardOutput=journal
StandardError=journal
"""
    body += "".join("BindPaths=" + value + "\n" for value in binds)
    if any(value.endswith(":" + SOCKET) for value in binds):
        body += f"ReadWritePaths=+{SOCKET}\n"
    if writable:
        body += "ReadWritePaths=" + writable + "\n"
    path.write_text(body)
    return path


def start(path: Path) -> str:
    application.command("systemctl", "daemon-reload")
    application.command("systemctl", "start", path.name)
    return launcher.show(path.name)["ControlGroup"]


def oneshot(path: Path) -> None:
    group = start(path)
    final = wait_done(path.name, 150)
    print("DB_SETUP_LOG=" + application.logs(path.name), flush=True)
    assert final["Result"] == "success" and final["MainPID"] == "0", final
    assert group_quiescent(
        Path("/sys/fs/cgroup") / group.lstrip("/"), final["ActiveState"]
    )


def build(root: Path, media: Path, suffix: str, paths: list[Path]) -> Path | None:
    if not (media / "db-build.json").exists():
        return None
    plan = json.loads((media / "db-build.json").read_text())
    assert artifact.sha(media / "db-build.tar") == plan["tarSha256"]
    inputs = root / "db-build"
    inputs.mkdir()
    with tarfile.open(media / "db-build.tar") as archive:
        for item in archive.getmembers():
            name = Path(item.name)
            assert item.isfile() and not name.is_absolute() and ".." not in name.parts
        archive.extractall(inputs, filter="data")
    assert set(plan["files"]) == {
        path.relative_to(inputs).as_posix()
        for path in inputs.rglob("*")
        if path.is_file()
    }
    assert all(
        artifact.sha(inputs / name) == digest for name, digest in plan["files"].items()
    )
    (inputs / "api/node_modules").symlink_to(
        "/artifact/apps/api/node_modules", target_is_directory=True
    )
    output = root / "db-built"
    output.mkdir(mode=0o700)
    os.chown(output, 55000, 55000)
    compiler = unit(
        root / "rootfs",
        f"image-db-build-{suffix}.service",
        "/usr/bin/node /run/db_build.mjs",
        [f"{output}:/run/build-output"],
        "+/run/build-output",
    )
    compiler.write_text(
        compiler.read_text()
        + f"BindReadOnlyPaths={inputs}:/run/db-build\nBindReadOnlyPaths={Path(__file__).with_name('db_build.mjs')}:/run/db_build.mjs\n"
    )
    paths.append(compiler)
    oneshot(compiler)
    result = [
        json.loads(line.split("=", 1)[1])
        for line in application.logs(compiler.name).splitlines()
        if line.startswith("DB_BUILD_RESULT=")
    ]
    assert len(result) == 1 and result[0]["sourceSha256"] == plan["sourceSha256"]
    assert result[0]["linuxEmitMatchesCompiled"] is True
    compiled = output / "db.service.js"
    assert artifact.sha(compiled) == result[0]["outputSha256"] == plan["compiledSha256"]
    return compiled


def run(root: Path, manifest: dict[str, object]) -> None:
    assert (
        Path("/etc/image-acceptance-disposable").read_text()
        == "isolated-image-fixtures-v1\n"
    )
    from test_policy import ParserTests
    from test_systemd import LifecyclePolicyTests

    suite = unittest.TestSuite(
        [
            ParserTests("test_manager_is_required"),
            ParserTests("test_manager_parser_requires_pin_and_no_effective_overrides"),
            LifecyclePolicyTests("test_child_oom_selection_in_every_scope"),
        ]
    )
    checked = unittest.TextTestRunner(verbosity=2).run(suite)
    assert checked.wasSuccessful() and not checked.skipped
    print("BROKER_PORTABLE=3 PASSED", flush=True)
    import pwd

    try:
        account = pwd.getpwuid(55000)
        assert account.pw_name == "imagefixture" and account.pw_gid == 55000
    except KeyError:
        application.command("groupadd", "--gid", "55000", "imagefixture")
        application.command(
            "useradd",
            "--uid",
            "55000",
            "--gid",
            "55000",
            "--no-create-home",
            "--home-dir",
            "/nonexistent",
            "--shell",
            "/usr/sbin/nologin",
            "imagefixture",
        )
    media = Path("/mnt/db-fixture")
    media.mkdir()
    application.command(
        "mount",
        "-t",
        "iso9660",
        "-o",
        "ro,nosuid,nodev,noexec",
        "/dev/disk/by-label/DB_FIXTURE",
        str(media),
    )
    summary = json.loads((media / "summary.json").read_text())
    assert (
        summary["sourceImage"]
        == "postgres@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af"
    )
    assert artifact.sha(media / "rootfs.tar") == summary["rootfsSha256"]
    assert artifact.sha(media / "manifest.json") == summary["manifestSha256"]
    pg_manifest = json.loads((media / "manifest.json").read_text())
    server = root / "postgres"
    server.mkdir()
    with tarfile.open(media / "rootfs.tar") as archive:
        names = set()
        for item in archive.getmembers():
            name = Path(item.name)
            assert (
                not name.is_absolute()
                and ".." not in name.parts
                and name.parts[0] == "rootfs"
            )
            assert (
                item.name not in names
                and not item.islnk()
                and (item.isfile() or item.isdir() or item.issym())
            )
            names.add(item.name)
            if item.issym():
                assert not Path(item.linkname).is_absolute()
        archive.extractall(server, filter="data")
    server /= "rootfs"
    for item in pg_manifest["entries"]:
        if item["type"] != "symlink":
            path = server / item["path"]
            assert path.resolve(strict=True).is_relative_to(server)
            path.chmod(int(item["mode"], 8))
    artifact.verify(server, pg_manifest)
    print("POSTGRES_ARTIFACT_VERIFIED=" + json.dumps(summary), flush=True)
    # Neither the PGDATA nor socket exists outside this fresh VM's tmpfs.
    resources = Path(tempfile.mkdtemp(prefix="korzina-db-fixture-", dir="/run"))
    resources.chmod(0o755)
    for name, options in (("data", "size=128M"), ("socket", "size=8M")):
        (resources / name).mkdir()
        application.command(
            "mount",
            "-t",
            "tmpfs",
            "-o",
            f"rw,nosuid,nodev,noexec,{options},mode=0700,uid=55000,gid=55000",
            "tmpfs",
            str(resources / name),
        )
    (resources / "socket/owned").write_text("korzina-db-pool-disposable-v1\n")
    os.chown(resources / "socket/owned", 55000, 55000)
    (resources / "socket/owned").chmod(0o600)
    suffix = uuid.uuid4().hex
    shared = [f"{resources / 'socket'}:{SOCKET}"]
    server_binds = [*shared, f"{resources / 'data'}:/data"]
    paths = []
    running = None
    results = []
    try:
        guards = unit(
            root / "rootfs",
            f"image-db-guards-{suffix}.service",
            "/usr/bin/node --test /run/db_lifecycle_test.mjs",
            shared,
        )
        guards.write_text(
            guards.read_text()
            + "".join(
                f"BindReadOnlyPaths={Path(__file__).with_name(name)}:/run/{name}\n"
                for name in ("db_lifecycle.mjs", "db_lifecycle_test.mjs")
            )
        )
        paths.append(guards)
        oneshot(guards)
        init = unit(
            server,
            f"image-db-init-{suffix}.service",
            PG
            + "initdb -D /data --username=fixture --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8",
            server_binds,
            "+/data",
        )
        paths.append(init)
        oneshot(init)
        running = unit(
            server,
            f"image-db-server-{suffix}.service",
            PG
            + f"postgres -D /data -c listen_addresses= -c unix_socket_directories={SOCKET} -c unix_socket_permissions=0700 -c default_transaction_read_only=on -c max_connections=8 -c shared_buffers=16MB -c dynamic_shared_memory_type=mmap -c jit=off",
            server_binds,
            "+/data",
        )
        paths.append(running)
        running.write_text(
            running.read_text().replace("RuntimeMaxSec=180", "RuntimeMaxSec=600")
        )
        server_group = start(running)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if "database system is ready to accept connections" in application.logs(
                running.name
            ):
                break
            assert launcher.show(running.name)["ActiveState"] == "active"
            time.sleep(0.5)
        else:
            raise AssertionError("fixture PostgreSQL readiness deadline")
        create = unit(
            server,
            f"image-db-create-{suffix}.service",
            PG + f"createdb --host={SOCKET} --username=fixture korzina_pool_fixture",
            shared,
        )
        create.write_text(
            # Setup alone may create the empty fixture DB. Server/probes retain
            # the PGOPTIONS scrub and default_transaction_read_only=on.
            create.read_text().replace(
                "PGSERVICEFILE PGOPTIONS NODE_OPTIONS", "PGSERVICEFILE NODE_OPTIONS"
            )
            + "Environment=PGOPTIONS=-cdefault_transaction_read_only=off\n"
        )
        paths.append(create)
        oneshot(create)
        candidate = None
        modes = [("compiled-base", "close"), ("compiled-base", "signal")]
        if (media / "db-build.json").exists():
            # Verify preparation and the fix first; retain the same baseline cases.
            modes = [
                ("compiled-candidate", "close"),
                ("compiled-candidate", "signal"),
                *modes,
            ]
        for subject, mode in modes:
            if subject == "compiled-candidate" and candidate is None:
                candidate = build(root, media, suffix, paths)
                assert candidate is not None
            probe = unit(
                root / "rootfs",
                f"image-db-pool-{subject}-{mode}-{suffix}.service",
                f"/usr/bin/node /run/db_lifecycle.mjs --{mode}",
                shared,
            )
            script = Path(__file__).with_name("db_lifecycle.mjs")
            probe.write_text(
                probe.read_text()
                + f"BindReadOnlyPaths={script}:/run/db_lifecycle.mjs\n"
            )
            if subject == "compiled-candidate":
                probe.write_text(
                    probe.read_text()
                    + f"BindReadOnlyPaths={candidate}:/artifact/apps/api/dist/db/db.service.js\n"
                )
            paths.append(probe)
            group = start(probe)
            began = time.monotonic()
            if mode == "signal":
                deadline = began + 60
                while time.monotonic() < deadline:
                    if "DB_POOL_READY=" in application.logs(probe.name):
                        break
                    assert launcher.show(probe.name)["ActiveState"] == "active"
                    time.sleep(0.25)
                else:
                    raise AssertionError("real pool startup deadline")
                began = time.monotonic()
                application.command("systemctl", "stop", probe.name)
            final = wait_done(probe.name, 75)
            elapsed = time.monotonic() - began
            log = application.logs(probe.name)
            print("DB_POOL_LOG=" + log, flush=True)
            assert final["MainPID"] == "0" and final["NRestarts"] == "0"
            assert group_quiescent(
                Path("/sys/fs/cgroup") / group.lstrip("/"), final["ActiveState"]
            )
            observed = [
                json.loads(line.split("=", 1)[1])
                for line in log.splitlines()
                if line.startswith("DB_POOL_RESULT=")
            ]
            assert (
                len(observed) == 1 and observed[0]["manualFixtureCleanupClosedBackend"]
            )
            assert final["Result"] in ("success", "exit-code"), final
            if subject == "compiled-candidate":
                assert final["Result"] == "success", final
            if mode == "signal":
                assert elapsed < 30, "pool shutdown exceeded the stop budget"
            results.append(
                {
                    "subject": subject,
                    "mode": mode,
                    "result": observed[0],
                    "elapsedSeconds": elapsed,
                    "unitResult": final["Result"],
                    "exitCode": final["ExecMainCode"],
                    "exitStatus": final["ExecMainStatus"],
                    "cgroupQuiescent": True,
                }
            )
        application.command("systemctl", "stop", running.name)
        stopped = launcher.show(running.name)
        assert stopped["MainPID"] == "0" and stopped["Result"] == "success"
        assert group_quiescent(
            Path("/sys/fs/cgroup") / server_group.lstrip("/"), stopped["ActiveState"]
        )
        artifact.verify(server, pg_manifest)
        artifact.verify(root / "rootfs", manifest)
        print(
            "DB_FIXTURE_RESULT="
            + json.dumps(
                {
                    "cases": results,
                    "serverStopped": True,
                    "runtimeArtifactsUnchanged": True,
                    "transport": "Unix socket only",
                    "productionApply": "SANDBOX_UNVERIFIED",
                }
            ),
            flush=True,
        )
        if candidate is not None:
            assert all(
                not item["result"]["productHookEndedPool"]
                for item in results
                if item["subject"] == "compiled-base"
            ), "BASELINE_UNEXPECTED"
            assert all(
                item["result"]["productHookEndedPool"]
                for item in results
                if item["subject"] == "compiled-candidate"
            ), "DB_LIFECYCLE_HOOK_MISSING"
        else:
            assert all(item["result"]["productHookEndedPool"] for item in results), (
                "DB_LIFECYCLE_HOOK_MISSING"
            )
    finally:
        for path in reversed(paths):
            print("DB_FINAL_LOG=" + application.logs(path.name), flush=True)
            application.command("systemctl", "stop", path.name)
            assert launcher.show(path.name)["MainPID"] == "0"
        for name in ("socket", "data"):
            application.command("umount", str(resources / name))
