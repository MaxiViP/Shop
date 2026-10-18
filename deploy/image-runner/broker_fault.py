"""Fail-closed response tests in the real sandbox; fake peers are explicitly pinned."""

import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import time

sys.path.insert(0, "/opt/image-runner")
import broker
import launcher


def check(instance: str, digest: str, attack: str) -> None:
    endpoint = Path("/run/broker-fault-" + attack + ".sock")
    ready, signal = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(ready)
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as server:
                server.bind(str(endpoint))
                endpoint.chmod(0o600)
                server.listen(1)
                server.settimeout(8)
                os.write(signal, b"1")
                os.close(signal)
                channel, _ = server.accept()
                with channel:
                    channel.settimeout(6)
                    query = json.loads(channel.recv(4096))
                    if attack == "timeout":
                        assert not channel.recv(1)
                    else:
                        response = {
                            "version": 1,
                            "nonce": query["nonce"],
                            "requestSha256": digest,
                            "units": {
                                unit: {"Id": unit} for unit in broker.names(instance)
                            },
                        }
                        if attack == "nonce":
                            response["nonce"] = (
                                "1" if query["nonce"][0] == "0" else "0"
                            ) + query["nonce"][1:]
                        elif attack == "binding":
                            response["requestSha256"] = "0" * 64
                        elif attack == "boolean-version":
                            response["version"] = True
                        elif attack == "foreign-unit":
                            response["units"]["shop-api.service"] = {}
                        elif attack == "secret-property":
                            response["units"][broker.names(instance)[0]][
                                "Environment"
                            ] = "refused"
                        elif attack == "field-type":
                            response["units"][broker.names(instance)[0]]["MainPID"] = 1
                        raw = json.dumps(response).encode()
                        if attack == "oversize":
                            raw = b"x" * 65537
                        elif attack == "duplicate-key":
                            raw = b'{"version":1,"version":1}'
                        channel.sendall(raw)
            os._exit(0)
        except BaseException:
            os._exit(1)
    os.close(signal)
    descriptor = os.pidfd_open(pid)
    original = broker.ENDPOINT
    try:
        assert os.read(ready, 1) == b"1"
        device, inode = broker.fd_identity(descriptor)
        info = endpoint.stat()
        config = {
            "pidfdDev": device,
            "pidfdIno": inode,
            "socketDev": info.st_dev,
            "socketIno": info.st_ino,
        }
        broker.ENDPOINT = endpoint
        started = time.monotonic()
        try:
            broker.Client(instance, config, digest).show(broker.names(instance)[0])
        except broker.Denied as error:
            expected = (
                "MESSAGE_LIMIT"
                if attack == "oversize"
                else "DUPLICATE_KEY"
                if attack == "duplicate-key"
                else "BROKER_REPLY_UNVERIFIED"
            )
            assert str(error) == expected, (attack, str(error))
            assert time.monotonic() - started < 5
        except TimeoutError:
            assert attack == "timeout"
            assert time.monotonic() - started < 5
        else:
            raise AssertionError("unsafe broker reply accepted: " + attack)
    finally:
        broker.ENDPOINT = original
        os.close(ready)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0, attack
        assert not broker.live(descriptor)
        broker.ENDPOINT = endpoint
        try:
            broker.Client(instance, config, digest).connect().close()
        except OSError:
            pass
        else:
            raise AssertionError("stopped broker accepted")
        broker.ENDPOINT = original
        os.close(descriptor)
        endpoint.unlink()


def main() -> None:
    assert len(sys.argv) == 2 and os.getpid() == 1 and os.geteuid() == 0
    launcher.process_policy(Path("/proc/self/status").read_text())
    raw = Path("/input/request.json").read_bytes()
    request = launcher.request(raw.decode(), sys.argv[1])
    digest = hashlib.sha256(raw).hexdigest()
    passed = []
    for name in (
        "timeout",
        "oversize",
        "nonce",
        "binding",
        "boolean-version",
        "foreign-unit",
        "secret-property",
        "field-type",
        "duplicate-key",
    ):
        check(sys.argv[1], digest, name)
        passed.append(name)
    config = dict(request["managerBroker"])
    config["socketIno"] += 1
    try:
        broker.Client(sys.argv[1], config, digest).connect().close()
    except broker.Denied as error:
        assert str(error) == "BROKER_ENDPOINT_UNVERIFIED"
    else:
        raise AssertionError("replaced endpoint accepted")
    passed.append("changed-endpoint")
    passed.append("stopped-peer")
    print(
        "BROKER_FAULT_RESULT="
        + json.dumps(
            {
                "passed": passed,
                "fakePeerTrustExplicit": True,
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
