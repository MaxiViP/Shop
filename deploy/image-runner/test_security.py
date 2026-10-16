"""Stage 5B-3 probes. Only new marked disposable VM units/data; no shop services."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import time
import unittest
import uuid

import preflight
import launcher as runner
import test_namespace as namespace
from security_payload import CODE, MARKER, UID
from test_systemd import counters, group_quiescent


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        import grp
        import pwd

        # Numeric systemd User/Group still need NSS records on this guest.
        # Reserve an unused identity only in the preflighted disposable VM.
        for lookup in (pwd.getpwuid, grp.getgrgid):
            try:
                lookup(UID)
            except KeyError:
                pass
            else:
                raise RuntimeError("security fixture identity already exists")
        account = "image-security-fixture"
        subprocess.run(["groupadd", "--gid", str(UID), account], check=True, timeout=10)
        subprocess.run(
            [
                "useradd",
                "--system",
                "--uid",
                str(UID),
                "--gid",
                str(UID),
                "--no-create-home",
                "--no-log-init",
                "--home-dir",
                "/nonexistent",
                "--shell",
                "/usr/sbin/nologin",
                account,
            ],
            check=True,
            timeout=10,
        )
        assert pwd.getpwnam(account).pw_uid == UID
        assert grp.getgrnam(account).gr_gid == UID
        cls.root = Path(
            tempfile.mkdtemp(prefix="image-security-fixture-", dir="/var/tmp")
        ).resolve()
        cls.root.chmod(0o755)
        cls.identity = (cls.root.stat().st_dev, cls.root.stat().st_ino)
        cls.retained = False
        (cls.root / "marker").write_text(MARKER)
        (cls.root / "marker").chmod(0o444)
        (cls.root / "cases").mkdir(mode=0o755)
        (cls.root / "cases").chmod(0o755)
        (cls.root / "runtime").mkdir(mode=0o700)
        (cls.root / "control").mkdir(mode=0o700)
        (cls.root / "control/secret").write_bytes(b"synthetic-control-secret")
        cls.rootfs = cls.root / "runtime/rootfs"
        namespace.runtime(cls.rootfs)
        shutil.copyfile(
            Path(__file__).with_name("security_payload.py"),
            cls.rootfs / "opt/image-runner/security_payload.py",
        )
        (cls.rootfs / "opt/image-runner/security_payload.py").chmod(0o644)
        (cls.rootfs / "etc/image-security-fixture").write_text(MARKER)
        (cls.rootfs / "etc/image-security-fixture").chmod(0o444)
        cls.helpers = cls.root / "helpers"
        cls.helpers.mkdir(mode=0o755)
        cls.helpers.chmod(0o755)
        (cls.rootfs / "opt/security/bin").mkdir(parents=True, mode=0o755)
        (cls.rootfs / "opt/security").chmod(0o755)
        (cls.rootfs / "opt/security/bin").chmod(0o755)
        if os.statvfs(cls.helpers).f_flag & os.ST_NOSUID:
            raise RuntimeError(
                "NOT VERIFIED: privileged-exec positive control requires suid VM scratch filesystem"
            )
        python = Path("/usr/bin/python3")
        cls.python_sha = hashlib.sha256(python.read_bytes()).hexdigest()
        for base in (cls.helpers, cls.rootfs / "opt/security/bin"):
            for name in ("plain", "suid", "fcap"):
                path = base / name
                shutil.copyfile(python, path)
                path.chmod(0o4755 if name == "suid" else 0o555)
                if name == "fcap":
                    os.setxattr(
                        path,
                        "security.capability",
                        struct.pack("<IIIII", 0x02000001, 0xE4, 0, 0, 0),
                    )
                assert hashlib.sha256(path.read_bytes()).hexdigest() == cls.python_sha
                assert path.stat().st_uid == 0 and path.stat().st_nlink == 1

    @classmethod
    def tearDownClass(cls) -> None:
        if not cls.retained:
            assert cls.root.parent == Path("/var/tmp") and cls.root.name.startswith(
                "image-security-fixture-"
            )
            assert (cls.root.stat().st_dev, cls.root.stat().st_ino) == cls.identity
            assert (cls.root / "marker").read_text() == MARKER
            shutil.rmtree(cls.root)

    def command(self, *args: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["systemctl", *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr[:4096])
        return result

    def logs(self, unit: str) -> str:
        return subprocess.check_output(
            ["journalctl", "--unit", unit, "--no-pager", "-o", "cat"],
            text=True,
            timeout=10,
        )

    def install(self, body: str) -> str:
        name = "image-security-fixture-" + uuid.uuid4().hex + ".service"
        path = Path("/run/systemd/system") / name
        with path.open("x") as handle:
            handle.write(body)
        self.addCleanup(self.release, name)
        self.command("daemon-reload")
        self.command("start", name)
        return name

    def release(self, unit: str) -> None:
        assert re.fullmatch(r"image-security-fixture-[0-9a-f]{32}\.service", unit)
        subprocess.run(
            ["systemctl", "stop", unit], capture_output=True, timeout=20, check=False
        )
        values = runner.show(unit)
        group = (
            Path("/sys/fs/cgroup") / values["ControlGroup"].lstrip("/")
            if values["ControlGroup"]
            else None
        )
        dead = values["MainPID"] == "0" and values["ActiveState"] in (
            "inactive",
            "failed",
        )
        if not dead or (
            group is not None and not group_quiescent(group, values["ActiveState"])
        ):
            type(self).retained = True
            self.fail(
                "NOT VERIFIED: retain fixture for VM teardown; processes are not quiescent"
            )
        # Successful, unreferenced units may already have been garbage-collected.
        if values["ActiveState"] == "failed":
            self.command("reset-failed", unit)
        if int(values["NFileDescriptorStore"]):
            self.command("clean", "--what=fdstore", unit)
        self.assertEqual(runner.show(unit)["NFileDescriptorStore"], "0")
        (Path("/run/systemd/system") / unit).unlink()
        self.command("daemon-reload")

    def finished(self, unit: str, seconds: int = 125) -> dict[str, str]:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            values = runner.show(unit)
            if values["MainPID"] == "0" and values["ActiveState"] in (
                "inactive",
                "failed",
            ):
                self.assertEqual(values["Result"], "success", self.logs(unit))
                return values
            time.sleep(0.05)
        self.fail("NOT VERIFIED: security fixture did not finish")

    def case_root(self) -> Path:
        root = self.root / "cases" / uuid.uuid4().hex
        root.mkdir(mode=0o755)
        root.chmod(0o755)
        (root / "uploads").mkdir(mode=0o755)
        (root / "uploads").chmod(0o755)
        for name in (
            "products",
            "chat",
            "product-variants",
            ".product-image-state",
            ".product-image-state/work",
        ):
            path = root / "uploads" / name
            path.mkdir(mode=0o700)
            os.chown(path, UID, UID)
        for name in ("product-variants", ".product-image-state"):
            for operation in ("read", "write", "chmod", "unlink", "rename"):
                path = root / "uploads" / name / operation
                path.write_bytes(b"synthetic-security-storage-v1")
                path.chmod(0o600)
                os.chown(path, UID, UID)
        for name in ("products", "chat"):
            (root / "uploads" / name).chmod(0o750)
        original = root / "uploads/products/existing-original.webp"
        original.write_bytes(b"synthetic-original-preserved")
        original.chmod(0o640)
        os.chown(original, UID, UID)
        (root / "input").mkdir(mode=0o700)
        for name in ("request.json", "inventory.jsonl", "approval.json"):
            path = root / "input" / name
            path.write_text("{}\n")
            path.chmod(0o600)
        (root / "deploy.lock").write_bytes(b"synthetic security fixture fence")
        (root / "deploy.lock").chmod(0o600)
        return root

    def start_worker(self, root: Path, mode: str) -> str:
        template = (
            Path(__file__).resolve().parents[1] / "shop-image-runner@.service"
        ).read_text()
        placeholder = root / "render.service"
        pin = root / "pin.target"
        pin.write_text("[Unit]\nDescription=Disposable security fixture reference\n")
        body = namespace.render(template, root, placeholder, pin, "positive")
        body = body.replace(
            f"RootDirectory={root}/rootfs", f"RootDirectory={self.rootfs}"
        )
        body = body.replace(
            f"BindPaths={root}/storage:/storage", f"BindPaths={root}/uploads:/storage"
        )
        body = body.replace(f"{root}/storage/products", f"{root}/uploads/products")
        body = body.replace(
            "/opt/image-runner/fs_payload.py positive",
            "/opt/image-runner/security_payload.py " + mode,
        )
        body = body.replace(
            "ExecStart=/usr/bin/python3 -B ", "ExecStart=/usr/bin/python3 -I -B "
        )
        body = body.replace("RuntimeMaxSec=60", "RuntimeMaxSec=120")
        placeholder.write_text(body)
        return self.install(body)

    def test_capability_exec_bounds(self) -> None:
        controls = {}
        nnp_controls = {}
        for name in ("suid", "fcap"):
            result = subprocess.run(
                [str(self.helpers / name), "-I", "-B", "-c", CODE],
                user=UID,
                group=UID,
                extra_groups=[],
                close_fds=True,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=5,
                check=True,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            )
            controls[name] = json.loads(result.stdout)
            # Same suid-capable VM filesystem, without systemd/nosuid/seccomp:
            # isolate NNP's effect instead of attributing all protection to Bnd.
            wrapper = (
                "import ctypes,os,sys; "
                "assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0; "
                "os.execve(sys.argv[1],[sys.argv[1],'-I','-B','-c',sys.argv[2]],"
                "{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})"
            )
            isolated = subprocess.run(
                [
                    "/usr/bin/python3",
                    "-I",
                    "-B",
                    "-c",
                    wrapper,
                    str(self.helpers / name),
                    CODE,
                ],
                user=UID,
                group=UID,
                extra_groups=[],
                close_fds=True,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=5,
                check=True,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            )
            value = json.loads(isolated.stdout)
            self.assertEqual(value["uids"], [UID, UID, UID])
            self.assertEqual(value["nnp"], 1)
            self.assertTrue(
                all(
                    value["caps"][key] == 0
                    for key in ("CapEff", "CapPrm", "CapInh", "CapAmb")
                )
            )
            nnp_controls[name] = value
        self.assertEqual(controls["suid"]["uids"][1], 0)
        self.assertEqual(controls["fcap"]["caps"]["CapEff"], 0xE4)
        self.assertEqual(controls["fcap"]["nnp"], 0)
        unit = self.start_worker(self.case_root(), "caps")
        self.finished(unit)
        reports = [
            json.loads(line.split("SECURITY_WORKER=", 1)[1])
            for line in self.logs(unit).splitlines()
            if "SECURITY_WORKER=" in line
        ]
        self.assertEqual(len(reports), 1)
        print(
            "SECURITY_CAPS="
            + json.dumps(
                {
                    "positiveControls": controls,
                    "nnpControls": nnp_controls,
                    "worker": reports[0],
                    "helperSha256": self.python_sha,
                },
                sort_keys=True,
            ),
            flush=True,
        )

    def api_probe(self, root: Path, worker: str) -> dict[str, object]:
        values = runner.show(worker)
        group = Path("/sys/fs/cgroup") / values["ControlGroup"].lstrip("/")
        pids = (group / "cgroup.procs").read_text().split()
        self.assertEqual(len(pids), 2)
        pid = next(int(pid) for pid in pids if pid != values["MainPID"])
        config = root / "api.json"
        config.write_text(
            json.dumps({"rootIdentity": list(self.identity), "workerPid": pid})
        )
        config.chmod(0o644)
        template = (
            Path(__file__).resolve().parents[1] / "shop-api.service"
        ).read_text()
        lines = []
        for line in template.splitlines():
            key = line.split("=", 1)[0]
            if line == "[Install]":
                break
            if key in ("EnvironmentFile", "Wants", "After"):
                continue
            replacements = {
                "Description": "Disposable API security fixture",
                "User": str(UID),
                "Group": str(UID),
                "WorkingDirectory": str(root),
                "ExecStart": f"/usr/bin/python3 -I -B {Path(__file__).with_name('security_payload.py').resolve()} api {config}",
                "Restart": "no",
                "ReadWritePaths": str(root / "uploads"),
            }
            lines.append(key + "=" + replacements[key] if key in replacements else line)
        body = (
            "\n".join(lines)
            + "\nRuntimeMaxSec=20\nMemoryMax=128M\nMemorySwapMax=0\nCPUQuota=50%\nTasksMax=16\nLimitCORE=0\n"
        )
        # Keep API PrivateTmp. Only this new fixture is exposed read-only;
        # its selected uploads subtree retains the existing ReadWritePaths rule.
        body += f"BindReadOnlyPaths={self.root}:{self.root}\n"
        body = body.replace("/var/lib/korzinamarket/uploads", str(root / "uploads"))
        body = body.replace(
            "/var/lib/korzinamarket-image-runner",
            f"{self.root}/runtime {self.root}/control",
        )
        unit = self.install(body)
        self.finished(unit, 25)
        effective = runner.show(unit)
        self.assertEqual(effective["PrivatePIDs"], "yes")
        self.assertEqual(effective["PrivateTmp"], "yes")
        self.assertEqual(effective["ProtectSystem"], "strict")
        self.assertEqual(effective["NoNewPrivileges"], "yes")
        self.assertEqual(effective["User"], str(UID))
        self.assertEqual(effective["Group"], str(UID))
        self.assertEqual(effective["ReadWritePaths"].split(), [str(root / "uploads")])
        self.assertEqual(
            set(effective["ReadOnlyPaths"].split()),
            {
                str(root / "uploads" / name)
                for name in ("product-variants", ".product-image-state")
            },
        )
        self.assertEqual(
            set(effective["InaccessiblePaths"].split()),
            {str(self.root / "runtime"), str(self.root / "control")},
        )
        reports = [
            json.loads(line.split("SECURITY_API=", 1)[1])
            for line in self.logs(unit).splitlines()
            if "SECURITY_API=" in line
        ]
        self.assertEqual(len(reports), 1)
        return reports[0]

    def test_api_unit_boundary(self) -> None:
        root = self.case_root()
        unit = self.start_worker(root, "boundary")
        ready = root / "uploads/.product-image-state/work/worker-ready"
        deadline = time.monotonic() + 30
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertTrue(ready.exists(), self.logs(unit))
        report = self.api_probe(root, unit)
        for directory in ("product-variants", ".product-image-state"):
            self.assertFalse(
                any(value["allowed"] for value in report[directory].values()), report
            )
        self.assertTrue(report["products"]["allowed"] and report["chat"]["allowed"])
        self.assertFalse(
            any(
                report[key]["allowed"]
                for key in (
                    "procRoot",
                    "procAlias",
                    "ptrace",
                    "signal",
                    "control",
                    "runtime",
                    "storageParentWrite",
                )
            )
        )
        ready.with_name("finish").write_text("finish")
        self.finished(unit)
        print("SECURITY_API_BOUNDARY=" + json.dumps(report, sort_keys=True), flush=True)

    def test_namespace_under_bounded_cpu_load(self) -> None:
        load = self.install("""[Service]
Type=exec
User=65534
Group=65534
ExecStart=/usr/bin/python3 -I -B -c 'data=bytearray(16*1024**2); exec("while True: data[0]=(data[0]+1)%%256")'
Restart=no
RuntimeMaxSec=300
TimeoutStopSec=1
KillMode=control-group
SendSIGKILL=yes
MemoryMax=64M
MemorySwapMax=0
CPUQuota=25%
TasksMax=4
LimitCORE=0
NoNewPrivileges=yes
CapabilityBoundingSet=
PrivateNetwork=yes
ProtectSystem=strict
ProtectHome=yes
""")
        results = []
        group = Path("/sys/fs/cgroup") / runner.show(load)["ControlGroup"].lstrip("/")
        before = counters(group, "cpu.stat")
        self.assertEqual((group / "cpu.max").read_text().split(), ["25000", "100000"])
        self.assertEqual((group / "memory.max").read_text().strip(), str(64 * 1024**2))
        self.assertEqual((group / "pids.max").read_text().strip(), "4")
        for index in range(3):
            self.assertEqual(runner.show(load)["ActiveState"], "active")
            started = time.monotonic()
            namespace.NamespaceTests("test_actual_template_namespace").case("positive")
            results.append(
                {
                    "iteration": index + 1,
                    "seconds": round(time.monotonic() - started, 3),
                }
            )
        self.assertEqual(runner.show(load)["ActiveState"], "active")
        cpu = counters(group, "cpu.stat")["usage_usec"] - before["usage_usec"]
        self.assertGreater(cpu, 1000000)
        print(
            "SECURITY_NAMESPACE_STRESS="
            + json.dumps(
                {
                    "loadCpuQuota": "25%",
                    "loadMemoryMax": 64 * 1024**2,
                    "loadTasksMax": 4,
                    "loadCpuUsageUSec": cpu,
                    "workerTimeout": 20,
                    "iterations": results,
                },
                sort_keys=True,
            ),
            flush=True,
        )
