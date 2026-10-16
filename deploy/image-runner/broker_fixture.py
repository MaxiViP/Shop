"""Provision only the new read-only helper inside a marked local VM."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import application
import artifact
import broker
import launcher


def start(instance: str) -> tuple[str, dict[str, int], int]:
    assert (
        Path("/etc/image-acceptance-disposable").read_text()
        == "isolated-image-fixtures-v1\n"
    )
    directory = broker.binding_file(instance).parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    directory.chmod(0o700)
    name = f"image-manager-broker-{instance}.service"
    script = Path(__file__).with_name("broker.py")
    body = f"""[Unit]
Description=Disposable fixed read-only image manager broker
[Service]
Type=exec
ExecStart=/usr/bin/python3 -I -B {script} {instance}
Group=root
UMask=0177
Restart=no
RuntimeMaxSec=300
TimeoutStopSec=2
KillMode=control-group
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateNetwork=yes
PrivateDevices=yes
PrivateIPC=yes
PrivateTmp=yes
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
MemoryMax=128M
MemorySwapMax=0
CPUQuota=50%
TasksMax=16
LimitNOFILE=128
LimitCORE=0
ReadWritePaths={directory}
StandardInput=null
StandardOutput=journal
StandardError=journal
"""
    Path("/run/systemd/system", name).write_text(body)
    application.command("systemctl", "daemon-reload")
    application.command("systemctl", "start", name)
    state = launcher.show(name)
    fd = os.pidfd_open(int(state["MainPID"]))
    other = os.pidfd_open(1)
    try:
        assert broker.fd_identity(fd) != broker.fd_identity(other), (
            "unique pidfs inode required"
        )
    finally:
        os.close(other)
    endpoint = directory / "manager.sock"
    deadline = time.monotonic() + 8
    while not endpoint.exists() and broker.live(fd) and time.monotonic() < deadline:
        time.sleep(0.1)
    info = endpoint.stat()
    device, inode = broker.fd_identity(fd)
    return (
        name,
        {
            "pidfdDev": device,
            "pidfdIno": inode,
            "socketDev": info.st_dev,
            "socketIno": info.st_ino,
        },
        fd,
    )


def bind(instance: str, request: Path, unit: Path, pin: Path) -> None:
    path = broker.binding_file(instance)
    with path.open("x") as stream:
        json.dump(
            {
                "requestSha256": artifact.sha(request),
                "unitSha256": artifact.sha(unit),
                "pinSha256": artifact.sha(pin),
            },
            stream,
        )
    path.chmod(0o600)


def outsiders(instance: str, digest: str) -> None:
    endpoint = broker.binding_file(instance).parent / "manager.sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
        channel.settimeout(3)
        channel.connect(str(endpoint))
        channel.sendall(json.dumps(broker.message(instance, digest)).encode())
        try:
            assert not channel.recv(65536), "outside root caller accepted"
        except ConnectionResetError:
            pass
    code = """import errno,socket,sys
try:
    socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET).connect(sys.argv[1])
except PermissionError as error:
    assert error.errno == errno.EACCES
else:
    raise AssertionError('unprivileged caller connected')
"""
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", code, str(endpoint)],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=5,
        user=997,
        group=55001,
        extra_groups=[],
        env={"PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert result.returncode == 0, result.stderr
    print(
        "BROKER_OUTSIDERS="
        + json.dumps({"rootOutsideUnitRefused": True, "nodeUidAccessDenied": True}),
        flush=True,
    )
