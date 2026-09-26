"""Copy a memory card into the event workspace and a second backup, verified.

Every file is copied twice (workspace ``originals/`` plus a second backup
destination, e.g. an external drive whose contents later sync to cold cloud
storage) and each copy's SHA-256 is checked against the card before the card
counts as ingested. The card itself is only ever read.

Re-running ingest on the same card is safe: files already copied with the
same hash are skipped.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .workspace import Event

# Camera housekeeping files that are not photos.
_SKIP_NAMES = {".ds_store", "thumbs.db"}
_SKIP_SUFFIXES = {".ctg", ".thm", ".dat", ".xml", ".bin", ".ind", ".lrv"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class IngestResult:
    copied: int = 0
    skipped_existing: int = 0
    renamed: int = 0
    bytes: int = 0


def _card_files(card: Path):
    for dirpath, dirnames, filenames in os.walk(card):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith(".") or name.lower() in _SKIP_NAMES:
                continue
            if Path(name).suffix.lower() in _SKIP_SUFFIXES:
                continue
            yield Path(dirpath) / name


def _place(src_hash: str, dest: Path) -> tuple[Path, bool]:
    """Return (path to write, already_present). Never overwrites a different file."""
    if not dest.exists():
        return dest, False
    if sha256(dest) == src_hash:
        return dest, True
    n = 1
    while True:
        alt = dest.with_name(f"{dest.stem}__{n}{dest.suffix}")
        if not alt.exists():
            return alt, False
        if sha256(alt) == src_hash:
            return alt, True
        n += 1


def _copy_verified(src: Path, dest: Path, src_hash: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".partial")
    shutil.copy2(src, tmp)
    if sha256(tmp) != src_hash:
        tmp.unlink()
        raise IOError(f"verify failed copying {src} -> {dest}")
    os.replace(tmp, dest)
    os.chmod(dest, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)


def ingest_card(event: Event, card: str | Path, camera: str, backup: str | Path,
                progress=None) -> IngestResult:
    card = Path(card)
    backup = Path(backup)
    if camera not in event.cameras:
        raise ValueError(f"camera {camera!r} is not registered for this event; add it with a role first")
    if not card.is_dir():
        raise FileNotFoundError(card)
    if backup.resolve() == event.root.resolve() or event.root.resolve() in backup.resolve().parents:
        raise ValueError("the second backup must be outside the event workspace (ideally another drive)")

    primary_root = event.originals / camera
    backup_root = backup / event.name / camera
    result = IngestResult()
    files = list(_card_files(card))
    with open(event.ingest_log, "a") as log:
        for i, src in enumerate(files, 1):
            rel = src.relative_to(card)
            h = sha256(src)
            primary, p_done = _place(h, primary_root / rel)
            second, b_done = _place(h, backup_root / rel)
            if p_done and b_done:
                result.skipped_existing += 1
            else:
                if not p_done:
                    _copy_verified(src, primary, h)
                if not b_done:
                    _copy_verified(src, second, h)
                if primary.name != src.name:
                    result.renamed += 1
                result.copied += 1
                result.bytes += src.stat().st_size
                log.write(json.dumps({
                    "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "camera": camera,
                    "source": str(src),
                    "sha256": h,
                    "primary": str(primary.relative_to(event.root)),
                    "backup": str(second),
                }) + "\n")
            if progress:
                progress(i, len(files))
    return result
