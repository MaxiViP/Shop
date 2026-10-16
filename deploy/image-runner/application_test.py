"""Opt-in artifact/application case, deliberately outside test_*.py discovery."""

import unittest

import application
import preflight


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class ApplicationTests(unittest.TestCase):
    def test_packaged_node_and_api(self) -> None:
        application.run()


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class ApplicationApiTests(unittest.TestCase):
    def test_packaged_api(self) -> None:
        application.run("application-api")


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class ApplicationWorkerTests(unittest.TestCase):
    def test_packaged_worker(self) -> None:
        application.run("application-worker")
