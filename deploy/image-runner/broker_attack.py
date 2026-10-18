"""Negative requests from the actual PID 1; then exec the real inspector."""

import hashlib
import json
import os
from pathlib import Path
import socket
import sys

sys.path.insert(0, "/opt/image-runner")
import broker
import launcher


def refused(channel: socket.socket, payload: bytes) -> None:
    channel.sendall(payload)
    try:
        data = channel.recv(65537)
        assert not data, "broker answered an unauthorized request"
    except ConnectionResetError:
        pass


def main() -> None:
    assert len(sys.argv) in (2, 3) and os.getpid() == 1 and os.geteuid() == 0
    launcher.process_policy(Path("/proc/self/status").read_text())
    raw = Path("/input/request.json").read_bytes()
    request = launcher.request(raw.decode(), sys.argv[1])
    client = broker.Client(
        sys.argv[1], request["managerBroker"], hashlib.sha256(raw).hexdigest()
    )
    if len(sys.argv) == 3:
        assert sys.argv[2] == "--outsider"
        try:
            client.show(client.units[0])
        except broker.Denied:
            print("BROKER_WRONG_UNIT=REFUSED", flush=True)
            return
        raise AssertionError("private PID 1 in another cgroup accepted")
    base = broker.message(client.instance, client.digest)
    attacks = {
        "start": base | {"operation": "start"},
        "stop": base | {"operation": "stop"},
        "reload": base | {"operation": "reload"},
        "foreign-unit": base | {"unit": "shop-api.service"},
        "properties": base | {"properties": ["Environment"]},
        "forged-identity": base | {"pid": 1, "uid": 0, "cgroup": "/"},
        "foreign-instance": base | {"instance": "550e8400-e29b-41d4-a716-446655440999"},
        "wrong-binding": base | {"requestSha256": "0" * 64},
    }
    passed = []
    for name, value in attacks.items():
        with client.connect() as channel:
            refused(channel, json.dumps(value).encode())
        passed.append(name)
    for name, value in (
        ("duplicate-key", b'{"version":1,"version":1}'),
        ("oversize", b"x" * 5000),
    ):
        with client.connect() as channel:
            refused(channel, value)
        passed.append(name)
    with client.connect() as channel:
        pid = os.fork()
        if pid == 0:
            try:
                refused(channel, json.dumps(base).encode())
                os._exit(0)
            except BaseException:
                os._exit(1)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0
    passed.append("inherited-connection-caller-substitution")
    wrong = dict(request["managerBroker"])
    wrong["pidfdIno"] += 1
    try:
        broker.Client(client.instance, wrong, client.digest).connect().close()
    except broker.Denied as error:
        assert str(error) == "BROKER_PEER_UNVERIFIED"
    else:
        raise AssertionError("forged broker pidfd accepted")
    passed.append("wrong-broker-pidfd")
    # A second root process and real socket cannot impersonate the pinned broker.
    fake = Path("/run/fake-manager.sock")
    pid = os.fork()
    if pid == 0:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as server:
                server.bind(str(fake))
                fake.chmod(0o600)
                server.listen(1)
                server.settimeout(3)
                channel, _ = server.accept()
                with channel:
                    assert not channel.recv(4096), "client sent data to fake broker"
            os._exit(0)
        except BaseException:
            os._exit(1)
    import time

    deadline = time.monotonic() + 2
    while not fake.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    original = broker.ENDPOINT
    try:
        info = fake.stat()
        wrong = dict(
            request["managerBroker"], socketDev=info.st_dev, socketIno=info.st_ino
        )
        broker.ENDPOINT = fake
        try:
            broker.Client(client.instance, wrong, client.digest).connect().close()
        except broker.Denied as error:
            assert str(error) == "BROKER_PEER_UNVERIFIED"
        else:
            raise AssertionError("root fake broker accepted")
    finally:
        broker.ENDPOINT = original
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0
    passed.append("root-fake-broker")
    # Actual authorized snapshot: properties come from the real manager.
    values = client.show(client.units[0])
    assert values["MainPID"].isdigit() and values["PrivatePIDs"] == "yes"
    print("BROKER_MANAGER_SNAPSHOT=" + json.dumps(values), flush=True)
    print(
        "BROKER_ATTACK_RESULT="
        + json.dumps(
            {
                "passed": passed,
                "authorizedSnapshot": True,
                "productionApply": "SANDBOX_UNVERIFIED",
            }
        ),
        flush=True,
    )
    os.execv(
        "/usr/bin/python3",
        ["/usr/bin/python3", "-I", "/opt/image-runner/launcher.py", client.instance],
    )


if __name__ == "__main__":
    main()
