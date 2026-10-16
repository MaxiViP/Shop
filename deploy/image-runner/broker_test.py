"""Portable trust-boundary regressions; kernel enforcement is tested in the VM."""

import json
import unittest

import broker
import launcher
from test_policy import INSTANCE, approved


class BrokerTests(unittest.TestCase):
    def test_request_binds_only_numeric_kernel_identity(self) -> None:
        identity = {"pidfdDev": 1, "pidfdIno": 2, "socketDev": 3, "socketIno": 4}
        request = approved() | {"managerBroker": identity}
        self.assertEqual(launcher.request(json.dumps(request), INSTANCE), request)
        for key in identity:
            for value in (None, True, False, 0, -1, 2**64, "2", {}, []):
                with (
                    self.subTest(key=key, value=value),
                    self.assertRaises(launcher.Refused),
                ):
                    launcher.request(
                        json.dumps(
                            request | {"managerBroker": identity | {key: value}}
                        ),
                        INSTANCE,
                    )
        for value in (
            None,
            {},
            identity | {"path": "/run/other.sock"},
            identity | {"uid": 0},
        ):
            with self.subTest(value=value), self.assertRaises(launcher.Refused):
                launcher.request(
                    json.dumps(request | {"managerBroker": value}), INSTANCE
                )

    def test_only_fixed_snapshot_for_the_bound_instance(self) -> None:
        binding = {"requestSha256": "a" * 64}
        request = broker.message(INSTANCE, binding["requestSha256"])
        broker.validate(request, INSTANCE, binding)
        for change in (
            {"operation": "start"},
            {"operation": "stop"},
            {"operation": "reload"},
            {"unit": "shop-api.service"},
            {"properties": ["Environment"]},
            {"instance": "550e8400-e29b-41d4-a716-446655440002"},
            {"requestSha256": "b" * 64},
            {"version": True},
            {"version": "1"},
            {"nonce": "../x"},
            {"nonce": "a" * 33},
            {"nonce": None},
            {"pid": 1, "uid": 0},
        ):
            with self.subTest(change=change), self.assertRaises(broker.Denied):
                broker.validate(request | change, INSTANCE, binding)

    def test_foreign_unit_is_refused_before_connect(self) -> None:
        identity = {"pidfdDev": 1, "pidfdIno": 2, "socketDev": 3, "socketIno": 4}
        client = broker.Client(INSTANCE, identity, "a" * 64)
        with self.assertRaisesRegex(broker.Denied, "UNIT_REFUSED"):
            client.show("shop-api.service")

    def test_duplicate_keys_and_non_objects_are_refused(self) -> None:
        for value in (b'{"version":1,"version":1}', b"[]", b"null", b"1"):
            with self.subTest(value=value), self.assertRaises(broker.Denied):
                broker.strict(value)


if __name__ == "__main__":
    unittest.main()
