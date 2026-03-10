#!/usr/bin/env python3
import argparse
import os
import shutil
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


def _guess_filename(url: str) -> str:
    path = urllib.parse.urlparse(url).path
    name = os.path.basename(path)
    return name if name else "download.bin"


def _format_bytes(size: float) -> str:
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)}{unit}"
            return f"{value:.1f}{unit}"
        value /= 1024
    return f"{value:.1f}TiB"


def _format_duration(seconds: float) -> str:
    seconds = float(seconds)
    if seconds < 60:
        return f"{seconds:.1f}s"
    if seconds < 3600:
        minutes = int(seconds // 60)
        remain = seconds - minutes * 60
        return f"{minutes}m{remain:.0f}s"
    hours = int(seconds // 3600)
    remain = seconds - hours * 3600
    minutes = int(remain // 60)
    secs = remain - minutes * 60
    return f"{hours}h{minutes}m{secs:.0f}s"


def _render_progress(label: str, downloaded: int, total: int, speed: float, suffix: str = "") -> str:
    if total > 0:
        percent = min(100.0, downloaded * 100.0 / total)
        bar_width = 28
        filled = min(bar_width, int(percent / 100.0 * bar_width))
        bar = "#" * filled + "-" * (bar_width - filled)
        line = (
            f"[{label}] [{bar}] {percent:6.2f}% "
            f"{_format_bytes(downloaded)}/{_format_bytes(total)} "
            f"{_format_bytes(speed)}/s"
        )
    else:
        line = f"[{label}] {_format_bytes(downloaded)} {_format_bytes(speed)}/s"
    if suffix:
        line += f" {suffix}"
    return line


def _render_extract_progress(
    extracted_bytes: int,
    total_bytes: int,
    speed: float,
    extracted_items: int,
    total_items: int,
) -> str:
    suffix = f"files={extracted_items}/{total_items}" if total_items > 0 else ""
    if total_bytes > 0:
        return _render_progress("extract", extracted_bytes, total_bytes, speed, suffix=suffix)

    if total_items > 0:
        percent = min(100.0, extracted_items * 100.0 / total_items)
        bar_width = 28
        filled = min(bar_width, int(percent / 100.0 * bar_width))
        bar = "#" * filled + "-" * (bar_width - filled)
        return f"[extract] [{bar}] {percent:6.2f}% files={extracted_items}/{total_items}"

    return "[extract] files=0/0"


def _emit_progress(line: str, is_tty: bool) -> None:
    if is_tty:
        print(line, end="\r", file=sys.stderr, flush=True)
        return
    print(line, file=sys.stderr, flush=True)


def _finish_progress(line: str, is_tty: bool) -> None:
    if is_tty:
        print(" " * max(len(line), 100), end="\r", file=sys.stderr, flush=True)
    print(line, file=sys.stderr, flush=True)


def _download(url: str, out_file: Path, force: bool) -> None:
    if out_file.exists() and out_file.stat().st_size > 0 and not force:
        print(
            f"[download] Reuse existing file: {out_file} size={_format_bytes(out_file.stat().st_size)}",
            file=sys.stderr,
        )
        return
    out_file.parent.mkdir(parents=True, exist_ok=True)
    is_tty = sys.stderr.isatty()
    with urllib.request.urlopen(url, timeout=60) as response, open(out_file, "wb") as f:
        total = int(response.headers.get("Content-Length", "0") or "0")
        downloaded = 0
        chunk_size = 1024 * 1024
        start = time.monotonic()
        last_emit = start
        emit_interval = 0.2 if is_tty else 1.0

        while True:
            chunk = response.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)

            now = time.monotonic()
            if now - last_emit < emit_interval:
                continue
            elapsed = max(now - start, 1e-6)
            line = _render_progress("download", downloaded, total, downloaded / elapsed)
            _emit_progress(line, is_tty)
            last_emit = now

        elapsed = max(time.monotonic() - start, 1e-6)
        final_line = (
            f"[download] Completed: {_format_bytes(downloaded)} "
            f"avg_speed={_format_bytes(downloaded / elapsed)}/s "
            f"time={_format_duration(elapsed)}"
        )
        if total > 0:
            final_line += f" total={_format_bytes(total)}"
        _finish_progress(final_line, is_tty)


def _resolve_unpack_result(extract_dir: Path) -> Path:
    children = [p for p in extract_dir.iterdir() if p.name != ".extract-ready"]
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return extract_dir


def _extract_tar_with_progress(archive: Path, extract_dir: Path) -> None:
    is_tty = sys.stderr.isatty()
    emit_interval = 0.2 if is_tty else 1.0

    with tarfile.open(archive, "r:*") as tar:
        members = tar.getmembers()
        total_bytes = sum(member.size for member in members if member.isfile())
        total_items = len(members)
        extracted_bytes = 0
        extracted_items = 0
        start = time.monotonic()
        last_emit = start

        for member in members:
            tar.extract(member, path=extract_dir)
            extracted_items += 1
            if member.isfile():
                extracted_bytes += member.size

            now = time.monotonic()
            if now - last_emit < emit_interval:
                continue
            elapsed = max(now - start, 1e-6)
            line = _render_extract_progress(
                extracted_bytes,
                total_bytes,
                extracted_bytes / elapsed if total_bytes > 0 else 0.0,
                extracted_items,
                total_items,
            )
            _emit_progress(line, is_tty)
            last_emit = now

        elapsed = max(time.monotonic() - start, 1e-6)
        if total_bytes > 0:
            final_line = (
                f"[extract] Completed: {_format_bytes(extracted_bytes)} "
                f"avg_speed={_format_bytes(extracted_bytes / elapsed)}/s "
                f"time={_format_duration(elapsed)} "
                f"files={extracted_items}/{total_items}"
            )
        else:
            final_line = f"[extract] Completed: files={extracted_items}/{total_items} time={_format_duration(elapsed)}"
        _finish_progress(final_line, is_tty)


def _extract_zip_with_progress(archive: Path, extract_dir: Path) -> None:
    is_tty = sys.stderr.isatty()
    emit_interval = 0.2 if is_tty else 1.0

    with zipfile.ZipFile(archive) as zf:
        members = zf.infolist()
        total_bytes = sum(member.file_size for member in members if not member.is_dir())
        total_items = len(members)
        extracted_bytes = 0
        extracted_items = 0
        start = time.monotonic()
        last_emit = start

        for member in members:
            zf.extract(member, path=extract_dir)
            extracted_items += 1
            if not member.is_dir():
                extracted_bytes += member.file_size

            now = time.monotonic()
            if now - last_emit < emit_interval:
                continue
            elapsed = max(now - start, 1e-6)
            line = _render_extract_progress(
                extracted_bytes,
                total_bytes,
                extracted_bytes / elapsed if total_bytes > 0 else 0.0,
                extracted_items,
                total_items,
            )
            _emit_progress(line, is_tty)
            last_emit = now

        elapsed = max(time.monotonic() - start, 1e-6)
        if total_bytes > 0:
            final_line = (
                f"[extract] Completed: {_format_bytes(extracted_bytes)} "
                f"avg_speed={_format_bytes(extracted_bytes / elapsed)}/s "
                f"time={_format_duration(elapsed)} "
                f"files={extracted_items}/{total_items}"
            )
        else:
            final_line = f"[extract] Completed: files={extracted_items}/{total_items} time={_format_duration(elapsed)}"
        _finish_progress(final_line, is_tty)


def _unpack_archive(archive: Path, extract_dir: Path) -> Path:
    suffixes = [suffix.lower() for suffix in archive.suffixes]
    is_tar = bool(suffixes) and (
        archive.name.lower().endswith(".tar")
        or archive.name.lower().endswith(".tar.gz")
        or archive.name.lower().endswith(".tgz")
        or archive.name.lower().endswith(".tar.bz2")
        or archive.name.lower().endswith(".tbz")
        or archive.name.lower().endswith(".tbz2")
        or archive.name.lower().endswith(".tar.xz")
        or archive.name.lower().endswith(".txz")
    )
    is_zip = archive.name.lower().endswith(".zip")

    try:
        if is_tar:
            _extract_tar_with_progress(archive, extract_dir)
            return _resolve_unpack_result(extract_dir)
        if is_zip:
            _extract_zip_with_progress(archive, extract_dir)
            return _resolve_unpack_result(extract_dir)

        print(f"[extract] Unpacking without progress support: {archive}", file=sys.stderr)
        shutil.unpack_archive(str(archive), str(extract_dir))
        print(f"[extract] Completed: {extract_dir}", file=sys.stderr)
        return _resolve_unpack_result(extract_dir)
    except (tarfile.TarError, zipfile.BadZipFile, shutil.ReadError, ValueError):
        return archive


def _try_unpack(archive: Path, extract_dir: Path) -> Path:
    marker = extract_dir / ".extract-ready"
    if marker.exists() and any(p.name != ".extract-ready" for p in extract_dir.iterdir()):
        print(f"[extract] Reuse extracted payload: {extract_dir}", file=sys.stderr)
        return _resolve_unpack_result(extract_dir)

    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    extract_dir.mkdir(parents=True, exist_ok=True)
    result = _unpack_archive(archive, extract_dir)
    if result == archive:
        return archive

    marker.touch()
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Download and optionally unpack an archive")
    parser.add_argument("--url", help="Download URL")
    parser.add_argument("--archive", help="Local archive path")
    parser.add_argument("--dest", help="Destination directory")
    parser.add_argument("--extract-dir", default="", help="Optional extraction directory override")
    parser.add_argument("--filename", default="", help="Optional file name override")
    parser.add_argument("--force", action="store_true", help="Force re-download")
    args = parser.parse_args()

    if bool(args.url) == bool(args.archive):
        parser.error("Specify exactly one of --url or --archive")
    if not args.dest and not args.extract_dir:
        parser.error("Specify --dest or --extract-dir")

    if args.dest:
        dest = Path(args.dest).expanduser().resolve()
        dest.mkdir(parents=True, exist_ok=True)
    else:
        dest = Path.cwd()

    if args.url:
        filename = args.filename if args.filename else _guess_filename(args.url)
        out_file = dest / filename
        _download(args.url, out_file, args.force)
    else:
        out_file = Path(args.archive).expanduser().resolve()
        if not out_file.exists():
            parser.error(f"Archive not found: {out_file}")

    unpack_dir = Path(args.extract_dir).expanduser().resolve() if args.extract_dir else dest / "extracted"
    result = _try_unpack(out_file, unpack_dir)
    print(str(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
