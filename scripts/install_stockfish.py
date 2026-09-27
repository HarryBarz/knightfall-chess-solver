#!/usr/bin/env python3
"""Install the official Stockfish 19 release; verify its published SHA-256."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RELEASE = "sf_19"
ASSETS = {
    "macos-universal": "a1f0e3bcc5a6927a11fe6fc8e54a779754645f3c2bae2cf13420fd1957adaa77",
    "linux-arm64-universal": "fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01",
    "linux-x86-64-universal": "9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded official archive")
    args = parser.parse_args()
    system, machine = platform.system(), platform.machine().lower()
    if system == "Darwin":
        target = "macos-universal"
    elif system == "Linux" and machine in ("aarch64", "arm64"):
        target = "linux-arm64-universal"
    elif system == "Linux" and machine in ("x86_64", "amd64"):
        target = "linux-x86-64-universal"
    else:
        raise SystemExit("Download Stockfish for your platform from https://stockfishchess.org/download/ and set STOCKFISH_PATH.")
    engine_dir = ROOT / "engines"
    engine_dir.mkdir(exist_ok=True)
    name = "stockfish-" + target + ".tar.gz"
    url = "https://github.com/official-stockfish/Stockfish/releases/download/" + RELEASE + "/" + name
    archive = args.archive or engine_dir / name
    if not archive.exists():
        print("Downloading official Stockfish 19 (~80 MB)...", flush=True)
        partial = archive.with_suffix(".partial")
        with urllib.request.urlopen(url, timeout=120) as source, partial.open("wb") as dest:
            shutil.copyfileobj(source, dest)
        partial.replace(archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != ASSETS[target]:
        raise SystemExit("Archive checksum mismatch. Remove the incomplete archive and run setup again.")
    destination = engine_dir / "stockfish-19"
    destination.mkdir(exist_ok=True)
    # Extract only regular files and directories, preserving accompanying license/source.
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            path = (destination / member.name).resolve()
            if destination.resolve() not in path.parents:
                raise SystemExit("Unexpected path in engine archive")
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, path.open("wb") as dest:
                    shutil.copyfileobj(source, dest)
                path.chmod(member.mode & 0o755)
    binaries = [p for p in destination.rglob("stockfish*") if p.is_file() and p.name in ("stockfish", "stockfish-" + target)]
    if len(binaries) != 1:
        raise SystemExit("Could not identify the engine binary; set STOCKFISH_PATH to the executable under engines/stockfish-19.")
    executable = binaries[0]
    executable.chmod(0o755)
    link = engine_dir / "stockfish"
    if link.is_symlink():
        link.unlink()
    elif link.exists():
        raise SystemExit("engines/stockfish already exists and is not a symlink; refusing to overwrite it.")
    link.symlink_to(executable.relative_to(engine_dir))
    metadata = {"release": RELEASE, "url": url, "sha256": digest, "binary": str(executable.relative_to(ROOT)), "source": "https://github.com/official-stockfish/Stockfish/tree/sf_19"}
    (engine_dir / "release.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print("Installed and checksum-verified Stockfish 19:", link)


if __name__ == "__main__":
    main()
