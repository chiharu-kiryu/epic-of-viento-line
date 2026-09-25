#!/usr/bin/env python3
"""Export application source, including uncommitted files, without any works or builds."""
import hashlib
import io
import json
import os
import re
from pathlib import Path
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
INPUTS = [".gitattributes", ".gitignore", ".github", "LICENSE", "README.md", "VERSION", "favicon.ico",
          "package.json", "package-lock.json", "engine", "web", "scripts", "mobile",
          "desktop", "src-tauri", "schemas", "docs"]
GENERATED = {"src-tauri/target", "src-tauri/binaries", "src-tauri/gen/schemas",
             "desktop/resources", "desktop/.cache", "desktop/ui/i18n", "web/data", "mobile/dist",
             "src-tauri/gen/android/.gradle", "src-tauri/gen/android/.kotlin", "src-tauri/gen/android/.tauri",
             "src-tauri/gen/android/build", "src-tauri/gen/android/app/build", "src-tauri/gen/android/buildSrc/build",
             "src-tauri/gen/android/buildSrc/.gradle", "src-tauri/gen/android/.idea",
             "src-tauri/gen/android/app/src/main/jniLibs", "src-tauri/gen/android/local.properties",
             "src-tauri/gen/android/app/tauri.properties", "src-tauri/gen/android/app/tauri.build.gradle.kts",
             "src-tauri/gen/android/app/proguard-tauri.pro", "src-tauri/gen/android/app/src/main/assets/tauri.conf.json",
             "src-tauri/gen/android/app/src/main/java/io/viento/studio/generated",
             "src-tauri/gen/android/tauri.settings.gradle", "src-tauri/gen/android/key.properties",
             "src-tauri/gen/android/keystore.properties"}


def source_files(directory):
    relative = directory.relative_to(ROOT).as_posix()
    if relative.startswith("src-tauri/gen/android/") and (
            directory.name in {".gradle", ".kotlin", ".idea", ".tauri", ".cxx", ".externalNativeBuild", "build", "captures"}
            or directory.suffix.lower() in {".jks", ".keystore", ".p12"}):
        return
    if (relative in GENERATED or directory.name.startswith(("._", ".resources-", ".dist-"))
            or directory.name in {"__pycache__", ".DS_Store"} or directory.suffix == ".pyc"):
        return
    if directory.is_symlink():
        raise ValueError(f"Source package does not follow symlinks: {relative}")
    if directory.is_dir():
        for child in sorted(directory.iterdir()):
            yield from source_files(child)
    elif directory.is_file():
        yield directory
    else:
        raise ValueError(f"Missing or unsupported source file: {relative}")


def parse_release_version(version):
    beta = re.fullmatch(r"b\.([0-9])\.([0-9])", version)
    if beta:
        return f"0.{beta[1]}.{beta[2]}"
    if re.fullmatch(r"[1-9][0-9]*\.[0-9]\.[0-9]", version):
        return version
    raise ValueError("VERSION must use b.X.Y (X and Y are digits 0–9) or a numeric release such as 1.0.0")


def main():
    version = (ROOT / "VERSION").read_text().strip()
    if json.loads((ROOT / "package.json").read_text())["version"] != parse_release_version(version):
        raise ValueError("Application build version does not match VERSION")
    name = f"Viento-Studio_{version}_source"
    destination = Path(sys.argv[1]) if len(sys.argv) == 2 else ROOT / "dist/current" / f"{name}.tar.gz"
    if len(sys.argv) > 2:
        raise ValueError("Usage: python3 desktop/package-source.py [OUTPUT.tar.gz]")
    destination = destination.resolve()
    # Source packaging only writes releases; it must never overwrite a source or
    # workspace file accidentally selected as its output.
    if not destination.is_relative_to(ROOT / "dist") or not destination.name.endswith(".tar.gz"):
        raise ValueError("Source archive must be a .tar.gz file under dist/")
    destination.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(p for entry in INPUTS for p in source_files(ROOT / entry))
    manifest = {}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix=".source-", delete=False) as output:
            temporary = Path(output.name)
            with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
                for file in files:
                    relative = file.relative_to(ROOT).as_posix()
                    content = file.read_bytes()
                    manifest[relative] = {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                    info = tarfile.TarInfo(f"{name}/{relative}")
                    info.size = len(content)
                    info.mode = 0o755 if file.stat().st_mode & 0o111 else 0o644
                    archive.addfile(info, io.BytesIO(content))
                content = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
                info = tarfile.TarInfo(f"{name}/SOURCE_MANIFEST.json")
                info.size = len(content)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(content))
            output.flush()
            os.fsync(output.fileno())
        # Read back every archived byte before replacing the previous artifact.
        with tarfile.open(temporary) as archive:
            for relative, expected in manifest.items():
                content = archive.extractfile(f"{name}/{relative}").read()
                if len(content) != expected["size"] or hashlib.sha256(content).hexdigest() != expected["sha256"]:
                    raise ValueError(f"Source verification failed: {relative}")
                if content != (ROOT / relative).read_bytes():
                    raise ValueError(f"Source changed during packaging: {relative}")
        os.replace(temporary, destination)
        print(json.dumps({"archive": str(destination), "files": len(files), "bytes": destination.stat().st_size}))
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
