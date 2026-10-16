"""Guest-only full acceptance entrypoint. No production entrypoint is ever invoked."""

import json
import os
from pathlib import Path
import sys
import subprocess
import unittest

import launcher as runner
import preflight


def select_suite(scope: str) -> unittest.TestSuite:
    if scope not in ("full", "child-oom", "lifecycle", "namespace-positive"):
        raise ValueError("unknown fixture scope")
    import test_systemd

    child = "test_child_cgroup_oom"
    names = unittest.defaultTestLoader.getTestCaseNames(test_systemd.SystemdTests)
    if child not in names:
        raise ValueError("missing child OOM acceptance case")
    if scope == "namespace-positive":
        import test_namespace

        suite = unittest.TestSuite(
            [test_namespace.NamespaceTests("test_actual_template_namespace")]
        )
    elif scope == "full":
        suite = unittest.defaultTestLoader.discover(
            str(Path(__file__).parent), "test_*.py"
        )
    else:
        suite = unittest.TestSuite(
            test_systemd.SystemdTests(name)
            for name in names
            if (name == child) == (scope == "child-oom")
        )
    if suite.countTestCases() == 0:
        raise ValueError("empty fixture selection")
    # Check discovery too: a renamed/missing module must not silently turn full
    # acceptance green without the mandatory child OOM test.
    pending = [suite]
    child_count = 0
    child_id = test_systemd.SystemdTests(child).id()
    while pending:
        for case in pending.pop():
            if isinstance(case, unittest.TestSuite):
                pending.append(case)
            elif case.id() == child_id:
                child_count += 1
    if child_count != (0 if scope in ("lifecycle", "namespace-positive") else 1):
        raise ValueError("incorrect child OOM fixture selection")
    return suite


def main(scope: str = "full") -> int:
    if scope not in ("full", "child-oom", "lifecycle", "namespace-positive"):
        raise ValueError("unknown fixture scope")
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
    suite = select_suite(scope)
    selected_count = suite.countTestCases()
    result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
    report = {
        "status": "PASSED"
        if result.wasSuccessful() and not result.skipped
        else "FAILED",
        "environment": environment,
        "tests": result.testsRun,
        "selection": scope,
        "selectedTests": selected_count,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skips": [(str(case), reason) for case, reason in result.skipped],
        "productionApply": "SANDBOX_UNVERIFIED",
        "scope": "synthetic systemd fixtures; not production packaging or deployment",
    }
    print("IMAGE_ACCEPTANCE_RESULT=" + json.dumps(report, sort_keys=True), flush=True)
    return 0 if report["status"] == "PASSED" else 1


if __name__ == "__main__":
    if len(sys.argv) > 2 or (
        len(sys.argv) == 2
        and sys.argv[1] not in ("--child-oom", "--lifecycle", "--namespace-positive")
    ):
        sys.exit(
            "Only fixed child-oom/lifecycle/namespace-positive selectors are accepted"
        )
    try:
        sys.exit(main(sys.argv[1][2:] if len(sys.argv) == 2 else "full"))
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
