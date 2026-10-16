"""Fixture-only runtime diagnosis; exec the unchanged inspector as PID 1."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys

sys.path.insert(0, "/opt/image-runner")
import launcher as runner


def probe(unit: str) -> dict[str, object]:
    result = subprocess.run(
        ["/usr/bin/systemctl", "show", "--all", "--no-pager", unit],
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=3,
        check=False,
    )
    return {
        "returncode": result.returncode,
        "stdoutBytes": len(result.stdout),
        "stderr": result.stderr[:2048].decode(errors="replace"),
        "bootMarker": Path("/run/systemd/system").is_dir(),
    }


def main() -> None:
    assert sys.platform == "linux" and os.getpid() == 1 and os.geteuid() == 0
    assert len(sys.argv) == 2 and runner.UUID.fullmatch(sys.argv[1])
    runner.process_policy(Path("/proc/self/status").read_text())
    assert stat.S_ISSOCK(Path("/run/systemd/private").stat().st_mode)
    unit = f"shop-image-runner@{sys.argv[1]}.service"
    before = probe(unit)
    created = False
    if (
        not before["bootMarker"]
        and before["returncode"] != 0
        and "System has not been booted with systemd" in str(before["stderr"])
    ):
        # Only an empty directory in this fixture's private /run tmpfs. No host
        # bind, permission, manager check or production unit is changed.
        Path("/run/systemd/system").mkdir(mode=0o755)
        created = True
    print(
        "LAUNCHER_RUNTIME_DIAGNOSTIC="
        + json.dumps(
            {
                "before": before,
                "createdPrivateBootMarker": created,
                "after": probe(unit),
                "productionUnitRuntimeVerified": False,
                "productionApply": "SANDBOX_UNVERIFIED",
            }
        ),
        flush=True,
    )
    os.execv(
        "/usr/bin/python3",
        ["/usr/bin/python3", "-I", "/opt/image-runner/launcher.py", sys.argv[1]],
    )


if __name__ == "__main__":
    main()
