"""Subject and team ID formats, QR payload parsing, and the ID registry.

Subject ID: one prefix letter plus four digits, e.g. ``A0347``.
Team ID:    ``T`` plus two digits, ``T01``..``T60`` (reusable card per slot).

The two formats differ in length, and subject prefixes never use ``T``, so a
subject code can never be mistaken for a team card.

The registry is a small SQLite file that records every Subject ID ever issued
so that IDs are never reused across events or devices. Offline check-in
devices get a pre-issued block (see ``issue(..., owner="device:TAB1")``).
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# I and O are skipped so a printed code is never read as 1 or 0.
# T is skipped so a hand-written subject code never looks like a team card.
PREFIX_LETTERS = "ABCDEFGHJKLMNPQRSUVWXYZ"
SUBJECT_RE = re.compile(r"^[A-Z]\d{4}$")
TEAM_RE = re.compile(r"^T\d{2}$")
MAX_TEAM_SLOT = 60

# QR codes may carry the bare code or a URL ending in it (e.g. a gallery or
# preorder link on a parent's phone). Anything else is "foreign".
_URL_TAIL_RE = re.compile(r"([A-Z]\d{4}|T\d{2})/?$")


@dataclass(frozen=True)
class ParsedCode:
    kind: str  # "subject", "team", or "foreign"
    code: str  # normalized code, or the raw payload when foreign


def parse_payload(payload: str) -> ParsedCode:
    raw = payload.strip()
    text = raw.upper()
    if TEAM_RE.match(text):
        slot = int(text[1:])
        if 1 <= slot <= MAX_TEAM_SLOT:
            return ParsedCode("team", text)
        return ParsedCode("foreign", raw)
    if SUBJECT_RE.match(text) and text[0] in PREFIX_LETTERS:
        return ParsedCode("subject", text)
    m = _URL_TAIL_RE.search(text)
    if m and ("/" in text or "=" in text):
        return parse_payload(m.group(1))
    return ParsedCode("foreign", raw)


def team_codes(count: int = MAX_TEAM_SLOT) -> list[str]:
    if not 1 <= count <= MAX_TEAM_SLOT:
        raise ValueError(f"team card count must be 1..{MAX_TEAM_SLOT}")
    return [f"T{n:02d}" for n in range(1, count + 1)]


def _all_codes_for(prefix: str):
    for n in range(1, 10000):  # 0000 is never issued
        yield f"{prefix}{n:04d}"


class Registry:
    """SQLite record of every Subject ID issued."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS subject_ids (
                   subject_id TEXT PRIMARY KEY,
                   batch      TEXT NOT NULL,
                   owner      TEXT NOT NULL,
                   issued_at  TEXT NOT NULL)"""
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def issue(self, count: int, owner: str = "stickers", prefix: str | None = None) -> list[str]:
        """Reserve ``count`` never-used Subject IDs and return them in order.

        ``owner`` records who holds the block, e.g. ``stickers`` for a printed
        sheet batch or ``device:TAB1`` for an offline check-in tablet.
        """
        if count < 1:
            raise ValueError("count must be positive")
        prefixes = [prefix.upper()] if prefix else list(PREFIX_LETTERS)
        for p in prefixes:
            if p not in PREFIX_LETTERS:
                raise ValueError(f"prefix must be one of {PREFIX_LETTERS}")
        used = {r[0] for r in self.db.execute("SELECT subject_id FROM subject_ids")}
        picked: list[str] = []
        for p in prefixes:
            for code in _all_codes_for(p):
                if code not in used:
                    picked.append(code)
                    if len(picked) == count:
                        break
            if len(picked) == count:
                break
        if len(picked) < count:
            raise RuntimeError("not enough unused Subject IDs left for that prefix")
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        batch = f"{now}:{owner}:{picked[0]}"
        with self.db:
            self.db.executemany(
                "INSERT INTO subject_ids VALUES (?, ?, ?, ?)",
                [(c, batch, owner, now) for c in picked],
            )
        return picked

    def is_issued(self, subject_id: str) -> bool:
        row = self.db.execute(
            "SELECT 1 FROM subject_ids WHERE subject_id = ?", (subject_id,)
        ).fetchone()
        return row is not None

    def issued(self) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT subject_id FROM subject_ids")}

    def batches(self) -> list[tuple[str, str, int, str, str]]:
        return list(
            self.db.execute(
                """SELECT batch, owner, COUNT(*), MIN(subject_id), MAX(subject_id)
                   FROM subject_ids GROUP BY batch ORDER BY MIN(rowid)"""
            )
        )
