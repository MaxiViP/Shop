import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import target_audit


class AuditTests(unittest.TestCase):
    def test_mount_credentials_are_never_emitted(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "mountinfo"
            path.write_text(
                "42 1 0:5 / /var/lib/korzinamarket/uploads rw,nosuid - cifs //hidden/share rw,password=never-emit,username=hidden,sec=ntlm\n"
            )
            result = target_audit.mount_metadata(path)
            text = json.dumps(result)
            self.assertNotIn("never-emit", text)
            self.assertNotIn("hidden", text)
            self.assertEqual(result[0]["options"], ["nosuid", "rw"])
            self.assertEqual(result[0]["otherOptionsOmitted"], 3)

    def test_no_environment_or_command_line_properties(self) -> None:
        self.assertFalse(
            {"Environment", "EnvironmentFiles", "ExecStart", "ExecStartPre"}
            & set(target_audit.PROPERTIES)
        )
        self.assertIn("PrivatePIDs", target_audit.PROPERTIES)
        self.assertIn("SupplementaryGroups", target_audit.PROPERTIES)

    def test_process_race_or_denial_preserves_audit_report(self) -> None:
        for error in (FileNotFoundError(2, "gone"), PermissionError(13, "denied")):
            with patch.object(target_audit, "read", side_effect=error):
                result = target_audit.process_metadata("123")
            self.assertEqual(result["inspection"]["errno"], error.errno)
        with patch.object(
            target_audit, "read", side_effect=AssertionError("must not read")
        ):
            self.assertIn("UNVERIFIED", target_audit.process_metadata("0")["status"])
