import unittest

import application
import preflight


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class EncodeTests(unittest.TestCase):
    def test_default_budget(self) -> None:
        application.run("readiness-encode")


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class LauncherTests(unittest.TestCase):
    def test_inspection(self) -> None:
        application.run("readiness-launcher")


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class StopTests(unittest.TestCase):
    def test_shutdown(self) -> None:
        application.run("readiness-stop")


@unittest.skipUnless(
    preflight.available(), "NOT VERIFIED: disposable systemd VM required"
)
class DatabaseTests(unittest.TestCase):
    def test_real_pool(self) -> None:
        application.run("readiness-db")
