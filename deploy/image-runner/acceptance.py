"""Guest-only full acceptance entrypoint. No production entrypoint is ever invoked."""

import json
import os
from pathlib import Path
import sys
import subprocess
import unittest

import launcher as runner
import preflight


def main() -> int:
    # vm.py creates this marker only in its fresh NoCloud guest. It authorizes
    # privileged fixture tests; actual kernel/manager proof is still mandatory.
    marker = Path("/etc/image-acceptance-disposable")
    if not marker.is_file() or marker.read_text() != "isolated-image-fixtures-v1\n":
        raise runner.Refused("DISPOSABLE_VM_MARKER_REQUIRED")
    os.environ["KORZINA_DISPOSABLE_SYSTEMD"] = "1"
    environment = preflight.evidence()
    # Only this marked, preflighted NoCloud VM is changed. Foreign binary formats
    # are unnecessary for native Python fixtures. Keep the runner's strict stacked
    # mount refusal; do not claim compatibility with a host retaining these mounts.
    binfmt_units = (
        "proc-sys-fs-binfmt_misc.automount",
        "systemd-binfmt.service",
        "proc-sys-fs-binfmt_misc.mount",
    )
    subprocess.run(
        ["systemctl", "mask", "--runtime", *binfmt_units], check=True, timeout=10
    )
    binfmt_states: dict[str, dict[str, str]] = {}
    for unit in binfmt_units:
        subprocess.run(["systemctl", "stop", unit], check=True, timeout=10)
        state = runner.show(unit)
        runner.require(
            state["LoadState"] == "masked" and state["ActiveState"] == "inactive",
            "GUEST_BINFMT_NOT_QUIESCENT",
        )
        binfmt_states[unit] = {
            "LoadState": state["LoadState"],
            "ActiveState": state["ActiveState"],
        }
    runner.require(
        not any(
            runner.beneath(
                line.split(" - ", 1)[0].split()[4], "/proc/sys/fs/binfmt_misc"
            )
            for line in Path("/proc/self/mountinfo").read_text().splitlines()
        ),
        "GUEST_BINFMT_MOUNT_RETAINED",
    )
    environment["guestBinfmt"] = {"units": binfmt_states, "mounts": "absent"}
    print("ACCEPTANCE_ENV=" + json.dumps(environment, sort_keys=True), flush=True)
    # These native-test mountpoints are new guest-only fixtures. Never mount host
    # cgroups or bind the Docker host into the guest.
    native = Path("/fixture-mounts")
    native.mkdir(mode=0o755)  # Existing directory means this is not a fresh guest.
    for name in ("one", "two", "readonly"):
        (native / name).mkdir(mode=0o755)
    for name in ("two", "readonly"):
        subprocess.run(
            ["mount", "--bind", str(native / "one"), str(native / name)],
            check=True,
            timeout=5,
        )
    subprocess.run(
        ["mount", "-o", "remount,bind,ro", str(native / "readonly")],
        check=True,
        timeout=5,
    )
    suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), "test_*.py")
    result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
    report = {
        "status": "PASSED"
        if result.wasSuccessful() and not result.skipped
        else "FAILED",
        "environment": environment,
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skips": [(str(case), reason) for case, reason in result.skipped],
        "productionApply": "SANDBOX_UNVERIFIED",
        "scope": "synthetic systemd fixtures; not production packaging or deployment",
    }
    print("IMAGE_ACCEPTANCE_RESULT=" + json.dumps(report, sort_keys=True), flush=True)
    return 0 if report["status"] == "PASSED" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        OSError,
        ValueError,
        IndexError,
        runner.Refused,
        subprocess.SubprocessError,
    ) as error:
        print(
            "IMAGE_ACCEPTANCE_RESULT="
            + json.dumps({"status": "NOT VERIFIED", "reason": str(error)}),
            flush=True,
        )
        sys.exit(78)
