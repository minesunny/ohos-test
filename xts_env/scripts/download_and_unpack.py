#!/usr/bin/env python3
import argparse
import os
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def _guess_filename(url: str) -> str:
    path = urllib.parse.urlparse(url).path
    name = os.path.basename(path)
    return name if name else "download.bin"


def _download(url: str, out_file: Path, force: bool) -> None:
    if out_file.exists() and out_file.stat().st_size > 0 and not force:
        return
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as response, open(out_file, "wb") as f:
        shutil.copyfileobj(response, f)


def _try_unpack(archive: Path, extract_dir: Path) -> Path:
    extract_dir.mkdir(parents=True, exist_ok=True)
    try:
        shutil.unpack_archive(str(archive), str(extract_dir))
    except (shutil.ReadError, ValueError):
        return archive

    children = [p for p in extract_dir.iterdir()]
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return extract_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="Download and optionally unpack an archive")
    parser.add_argument("--url", required=True, help="Download URL")
    parser.add_argument("--dest", required=True, help="Destination directory")
    parser.add_argument("--filename", default="", help="Optional file name override")
    parser.add_argument("--force", action="store_true", help="Force re-download")
    args = parser.parse_args()

    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    filename = args.filename if args.filename else _guess_filename(args.url)
    out_file = dest / filename
    _download(args.url, out_file, args.force)

    unpack_dir = dest / "extracted"
    result = _try_unpack(out_file, unpack_dir)
    print(str(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
