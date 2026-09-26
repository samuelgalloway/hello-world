"""Synthetic test shoot: fake memory cards with QR frames, portraits and team photos.

Used by the tests and by ``photoday demo`` to replay a shoot end to end,
optionally with injected problems, so every one of them can be seen landing in
the exceptions report.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFilter

W, H = 1800, 1200

PROBLEMS = (
    "unreadable_qr",      # one kid's QR frame is smudged
    "kid_without_photos",  # a kid's QR is shot, then the next kid's
    "test_shots",         # stray frames after a team card, before any kid
    "missing_team_card",  # team camera skips one team's card
    "unissued_id",        # a sticker that the registry never issued
)


@dataclass
class ShootPlan:
    teams: dict[str, list[str]]  # team code -> subject IDs in shooting order
    expected: dict[str, str] = field(default_factory=dict)  # photo rel name -> subject or team
    problems: dict[str, str] = field(default_factory=dict)  # problem -> ref


def _exif(t: datetime, serial: str):
    ex = Image.Exif()
    ex[0x0110] = "SynthCam"
    sub = ex.get_ifd(0x8769)
    sub[0x9003] = t.strftime("%Y:%m:%d %H:%M:%S")
    sub[0x9291] = f"{t.microsecond // 10000:02d}"
    sub[0xA431] = serial
    return ex


def _background(rng: random.Random, seed_color=None) -> Image.Image:
    base = seed_color or tuple(rng.randint(60, 200) for _ in range(3))
    im = Image.new("RGB", (W, H), base)
    d = ImageDraw.Draw(im)
    for _ in range(12):
        x, y = rng.randint(0, W), rng.randint(0, H)
        r = rng.randint(60, 300)
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(rng.randint(0, 255) for _ in range(3)))
    return im.filter(ImageFilter.GaussianBlur(6))


def qr_frame(code: str, rng: random.Random, smudge: bool = False) -> Image.Image:
    im = _background(rng)
    q = qrcode.make(code, border=2).convert("RGB")
    size = int(H * rng.uniform(0.35, 0.5))
    q = q.resize((size, size), Image.NEAREST).rotate(rng.uniform(-8, 8), expand=True, fillcolor="white")
    if smudge:
        # Keep the corner finder patterns (so the QR is detected) but wreck
        # the data columns between them, top to bottom.
        d = ImageDraw.Draw(q)
        cx, cy = q.width // 2, q.height // 2
        hw = int(size * 0.12)
        d.rectangle([cx - hw, cy - int(size * 0.42), cx + hw, cy + int(size * 0.42)], fill=(90, 90, 90))
    x = rng.randint(50, W - q.width - 50)
    y = rng.randint(50, H - q.height - 50)
    im.paste(q, (x, y))
    return im


def portrait(rng: random.Random, jersey) -> Image.Image:
    im = _background(rng)
    d = ImageDraw.Draw(im)
    cx = W // 2 + rng.randint(-100, 100)
    d.ellipse([cx - 140, 200, cx + 140, 520], fill=(224, 180, 150))  # head
    d.rectangle([cx - 260, 520, cx + 260, H], fill=jersey)  # jersey
    return im


def team_photo(rng: random.Random, jersey, n: int) -> Image.Image:
    im = _background(rng, (90, 150, 90))
    d = ImageDraw.Draw(im)
    for i in range(n):
        x = 120 + i * (W - 240) // max(n, 1)
        y = 350 if i % 2 else 600
        d.ellipse([x, y, x + 90, y + 110], fill=(224, 180, 150))
        d.rectangle([x - 20, y + 110, x + 110, y + 330], fill=jersey)
    return im


class _Card:
    def __init__(self, root: Path, serial: str, start: datetime, rng: random.Random):
        self.dir = root / "DCIM" / "100SYNTH"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.serial = serial
        self.t = start
        self.n = 0
        self.rng = rng

    def shoot(self, im: Image.Image, gap: float = 2.0) -> str:
        self.t += timedelta(seconds=gap + self.rng.uniform(0, 1.5))
        self.n += 1
        name = f"IMG_{self.n:04d}.JPG"
        im.save(self.dir / name, quality=85, exif=_exif(self.t, self.serial))
        return name


def make_shoot(root: str | Path, subject_ids: list[str], teams: int = 3, kids_per_team: int = 4,
               portraits_per_kid: int = 3, problems: tuple[str, ...] = (), seed: int = 7,
               start: datetime | None = None, unissued: str = "Z9999") -> ShootPlan:
    """Write two fake cards under ``root/indiv`` and ``root/team``."""
    root = Path(root)
    rng = random.Random(seed)
    start = start or datetime(2026, 10, 3, 9, 0, 0)
    indiv = _Card(root / "indiv", "IND001", start, rng)
    teamcam = _Card(root / "team", "TEAM01", start, rng)

    needed = teams * kids_per_team
    if len(subject_ids) < needed:
        raise ValueError(f"need {needed} subject IDs")
    ids = list(subject_ids[:needed])
    plan = ShootPlan(teams={})
    if "unissued_id" in problems:
        ids[1] = unissued
        plan.problems["unissued_id"] = unissued

    for ti in range(teams):
        code = f"T{ti + 1:02d}"
        kids = ids[ti * kids_per_team:(ti + 1) * kids_per_team]
        plan.teams[code] = kids
        jersey = tuple(rng.randint(0, 255) for _ in range(3))
        indiv.shoot(qr_frame(code, rng), gap=240)  # next team walks up
        if ti == 0 and "test_shots" in problems:
            n = indiv.shoot(portrait(rng, jersey))
            plan.problems["test_shots"] = f"indiv:{n}"
        for ki, kid in enumerate(kids):
            smudge = ti == 1 and ki == 1 and "unreadable_qr" in problems
            n = indiv.shoot(qr_frame(kid, rng, smudge=smudge), gap=8)
            if smudge:
                plan.problems["unreadable_qr"] = f"indiv:{n}"
            if ti == 2 and ki == 0 and "kid_without_photos" in problems:
                plan.problems["kid_without_photos"] = kid
                continue
            for _ in range(portraits_per_kid):
                n = indiv.shoot(portrait(rng, jersey), gap=1)
                plan.expected[f"indiv:{n}"] = kid
        # Team photo after individuals, on the other camera.
        teamcam.t = max(teamcam.t, indiv.t) + timedelta(minutes=2)
        if not (ti == teams - 1 and "missing_team_card" in problems):
            teamcam.shoot(qr_frame(code, rng))
        else:
            plan.problems["missing_team_card"] = code
        for _ in range(2):
            n = teamcam.shoot(team_photo(rng, jersey, kids_per_team))
            plan.expected[f"team:{n}"] = code
    return plan
