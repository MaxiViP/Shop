"""Provision only the new read-only helper inside a marked local VM."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys

import broker


start = broker.start
bind = broker.bind

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
