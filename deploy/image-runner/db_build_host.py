"""Curated compiler/source media; all execution stays in the disposable VM."""

import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import tarfile
import uuid

REPO = Path(__file__).resolve().parents[2]
INTEGRITY = "vSVh5cSo3Xxs6ghBCcFJlpbkbENzDog1qXtoXLa/HC3aCrR4XO76GZbXmQoCPHnu99nQpdCeC3H9tdNICfDh7A=="


def main() -> None:
    assert (
        len(sys.argv) == 7
        and sys.argv[1] == "--postgres-artifact"
        and sys.argv[3] == "--lint-package"
        and sys.argv[5] == "--api-checks"
    )
    postgres = Path(sys.argv[2]).resolve(strict=True)
    lint_archive = Path(sys.argv[4]).resolve(strict=True)
    check_receipt = Path(sys.argv[6]).resolve(strict=True)
    assert (
        postgres.parent.parent == REPO / "work"
        and postgres.parent.name.startswith("linux-postgres-")
        and postgres.name == "artifact"
    )
    assert lint_archive.is_relative_to(REPO / "work") and not lint_archive.is_symlink()
    assert (
        check_receipt.is_relative_to(REPO / "work") and not check_receipt.is_symlink()
    )
    checks = json.loads(check_receipt.read_text())
    source = (REPO / "apps/api/src/db/db.service.ts").read_bytes()
    assert checks["apiSourceSha256"] == hashlib.sha256(source).hexdigest()
    assert all(item["exitCode"] == 0 for item in checks["apiChecksAlreadyCompleted"])
    summary = json.loads((postgres / "summary.json").read_text())
    assert (
        hashlib.sha256((postgres / "rootfs.tar").read_bytes()).hexdigest()
        == summary["rootfsSha256"]
    )
    assert (
        base64.b64encode(hashlib.sha512(lint_archive.read_bytes()).digest()).decode()
        == INTEGRITY
    )
    folder = (
        REPO / "work" / ("linux-postgres-candidate-" + uuid.uuid4().hex) / "artifact"
    )
    folder.mkdir(parents=True)
    for name in ("rootfs.tar", "manifest.json", "summary.json"):
        shutil.copyfile(postgres / name, folder / name)
    files = {}
    for name in ("package.json", "tsconfig.json"):
        files["api/" + name] = (REPO / "apps/api" / name).read_bytes()
    files["api/src/db/db.service.ts"] = source
    files["api/compiled/db.service.js"] = (
        REPO / "apps/api/dist/db/db.service.js"
    ).read_bytes()
    files["checks.json"] = check_receipt.read_bytes()
    compiler = (REPO / "apps/api/node_modules/typescript").resolve(strict=True)
    assert compiler.is_relative_to(REPO / "node_modules")
    assert json.loads((compiler / "package.json").read_text())["version"] == "6.0.3"
    files["compiler/package.json"] = (compiler / "package.json").read_bytes()
    files["compiler/lib/typescript.js"] = (compiler / "lib/typescript.js").read_bytes()
    # Lint-only dependency, from the already exported pinned Bookworm image.
    # Require its libc to match the curated PostgreSQL artifact; Linux checks
    # the actual Node rootfs libc again before loading this library.
    pg_manifest = json.loads((postgres / "manifest.json").read_text())
    assert (
        hashlib.sha256((postgres / "manifest.json").read_bytes()).hexdigest()
        == summary["manifestSha256"]
    )
    pg_libc = next(
        item["sha256"]
        for item in pg_manifest["entries"]
        if item["path"] == "usr/lib/x86_64-linux-gnu/libc.so.6"
    )
    with tarfile.open(postgres.parent / "image.tar") as exported:
        contents = {}
        for name in ("libc.so.6", "librt.so.1"):
            member = exported.getmember("usr/lib/x86_64-linux-gnu/" + name)
            assert member.isfile() and member.size < 4 * 1024**2
            contents[name] = exported.extractfile(member).read()
    assert hashlib.sha256(contents["libc.so.6"]).hexdigest() == pg_libc
    files["lib/librt.so.1"] = contents["librt.so.1"]
    files["lint-libraries.json"] = json.dumps(
        {
            "sourceImage": summary["sourceImage"],
            "libcSha256": pg_libc,
            "librtSha256": hashlib.sha256(contents["librt.so.1"]).hexdigest(),
        }
    ).encode()
    lint = REPO / "node_modules/.pnpm/oxlint@1.80.0/node_modules/oxlint"
    for path in lint.rglob("*"):
        if (
            path.is_file()
            and not path.is_symlink()
            and "node_modules" not in path.relative_to(lint).parts
        ):
            files["oxlint/" + path.relative_to(lint).as_posix()] = path.read_bytes()
    with tarfile.open(lint_archive) as archive:
        for item in archive.getmembers():
            assert (
                item.isfile()
                and item.name.startswith("package/")
                and ".." not in Path(item.name).parts
            )
            files[
                "oxlint/node_modules/@oxlint/binding-linux-x64-gnu/"
                + item.name.removeprefix("package/")
            ] = archive.extractfile(item).read()
    with tarfile.open(folder / "db-build.tar", "w") as archive:
        for name, content in sorted(files.items()):
            assert (
                not name.startswith("/")
                and ".." not in Path(name).parts
                and ".env" not in name
            )
            item = tarfile.TarInfo(name)
            item.mode, item.size = 0o444, len(content)
            archive.addfile(item, io.BytesIO(content))
    data = {
        "files": {
            name: hashlib.sha256(content).hexdigest() for name, content in files.items()
        },
        "tarSha256": hashlib.sha256((folder / "db-build.tar").read_bytes()).hexdigest(),
        "sourceSha256": hashlib.sha256(files["api/src/db/db.service.ts"]).hexdigest(),
        "compiledSha256": hashlib.sha256(
            files["api/compiled/db.service.js"]
        ).hexdigest(),
        "apiCheckReceiptSha256": hashlib.sha256(files["checks.json"]).hexdigest(),
        "schemaSha256": hashlib.sha256(
            (REPO / "apps/api/prisma/schema.prisma").read_bytes()
        ).hexdigest(),
        "lockSha256": hashlib.sha256(
            (REPO / "pnpm-lock.yaml").read_bytes()
        ).hexdigest(),
        "linuxLintIntegrity": "sha512-" + INTEGRITY,
        "productionApply": "SANDBOX_UNVERIFIED",
    }
    (folder / "db-build.json").write_text(json.dumps(data, indent=2) + "\n")
    print(
        json.dumps(
            {
                "artifact": str(folder),
                "files": len(files),
                "sourceSha256": data["sourceSha256"],
            }
        )
    )


if __name__ == "__main__":
    main()
