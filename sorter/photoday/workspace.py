"""Event workspace layout on the ingest laptop.

    <event>/
      event.json            cameras, their roles and clock offsets
      originals/<camera>/   first backup copy; read-only, never modified
      ingest-log.jsonl      one line per file copied (sha256, both destinations)
      scan-cache.json       EXIF time + QR result per file, keyed by sha256
      overrides.csv         operator fixes for exceptions (optional)
      output/               manifest, exceptions report, sorted folders
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

ROLES = ("individuals", "team")


@dataclass
class Camera:
    name: str
    role: str
    clock_offset_seconds: float = 0.0


@dataclass
class Event:
    root: Path
    name: str
    cameras: dict[str, Camera] = field(default_factory=dict)

    @property
    def originals(self) -> Path:
        return self.root / "originals"

    @property
    def output(self) -> Path:
        return self.root / "output"

    @property
    def ingest_log(self) -> Path:
        return self.root / "ingest-log.jsonl"

    @property
    def scan_cache(self) -> Path:
        return self.root / "scan-cache.json"

    @property
    def overrides(self) -> Path:
        return self.root / "overrides.csv"

    @classmethod
    def open(cls, root: str | Path, create: bool = False) -> "Event":
        root = Path(root)
        cfg = root / "event.json"
        if not cfg.exists():
            if not create:
                raise FileNotFoundError(f"{root} is not an event workspace (no event.json)")
            root.mkdir(parents=True, exist_ok=True)
            ev = cls(root=root, name=root.name)
            ev.save()
            return ev
        data = json.loads(cfg.read_text())
        cams = {n: Camera(name=n, **c) for n, c in data.get("cameras", {}).items()}
        return cls(root=root, name=data.get("name", root.name), cameras=cams)

    def save(self) -> None:
        data = {
            "name": self.name,
            "cameras": {
                n: {"role": c.role, "clock_offset_seconds": c.clock_offset_seconds}
                for n, c in sorted(self.cameras.items())
            },
        }
        (self.root / "event.json").write_text(json.dumps(data, indent=2) + "\n")

    def add_camera(self, name: str, role: str, clock_offset_seconds: float | None = None) -> Camera:
        if role not in ROLES:
            raise ValueError(f"camera role must be one of {ROLES}")
        existing = self.cameras.get(name)
        if existing and existing.role != role:
            raise ValueError(f"camera {name!r} is already registered as {existing.role!r}")
        cam = existing or Camera(name=name, role=role)
        if clock_offset_seconds is not None:
            cam.clock_offset_seconds = clock_offset_seconds
        self.cameras[name] = cam
        self.save()
        return cam
