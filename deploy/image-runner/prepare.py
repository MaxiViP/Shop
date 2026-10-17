"""Read-only discovery child in the fixed template, never on the HTTP path."""
import os
from pathlib import Path
import pwd
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import launcher

if __name__ == "__main__":
    launcher.require(os.getpid() == 1 and os.geteuid() == 0, "NAMESPACE_REQUIRED")
    launcher.process_policy(Path("/proc/self/status").read_text())
    launcher.require(len(sys.argv) in (3, 4) and sys.argv[1] in ("1", "5", "20", "50"), "INVALID_BATCH")
    launcher.require(not sys.argv[2] or launcher.SOURCE.fullmatch(sys.argv[2]), "INVALID_CURSOR")
    if len(sys.argv) == 4:
        launcher.require(launcher.SOURCE.fullmatch(sys.argv[3]), "INVALID_IMAGE")
    account = pwd.getpwnam("shop")
    launcher.require(account.pw_uid == 997 and account.pw_gid > 0, "SHOP_IDENTITY_UNVERIFIED")
    result = subprocess.run(
        ["/usr/bin/node", "--import", "tsx", "data/product-image-production/prepare.ts", *sys.argv[1:]],
        cwd="/artifact/apps/api", user=account.pw_uid, group=account.pw_gid,
        extra_groups=[], stdin=subprocess.DEVNULL, timeout=540, check=False,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "NODE_ENV": "production",
             "TSX_DISABLE_CACHE": "1", "UV_THREADPOOL_SIZE": "1", "TMPDIR": "/tmp"},
    )
    sys.exit(result.returncode)
