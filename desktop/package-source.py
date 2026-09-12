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
          "package.json", "package-lock.json", "web", "scripts",
          "desktop", "src-tauri", "schemas", "docs"]
GENERATED = {"src-tauri/target", "src-tauri/binaries", "src-tauri/gen/schemas",
             "desktop/resources", "desktop/.cache", "web/data"}


def source_files(directory):
    relative = directory.relative_to(ROOT).as_posix()
    if (relative in GENERATED or directory.name.startswith(("._", ".resources-"))
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


def main():
    version = (ROOT / "VERSION").read_text().strip()
    match = re.fullmatch(r"[a-z]\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version)
    if not match or json.loads((ROOT / "package.json").read_text())["version"] != f"{match[1]}.{match[2]}.0":
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
