"""Run the sorter over an event workspace and write its outputs.

output/
  manifest.csv        every photo: camera, time, frame type, team, subject
  subjects.csv        one row per kid: team, photo count, first/last photo
  teams.csv           one row per team: kids, team photos
  exceptions.csv      every open problem, with the fix to make
  exceptions.html     the same, with thumbnails, for the operator
  sorted/<Txx>/<ID>/  (optional) hard links to each kid's photos, by team
"""

from __future__ import annotations

import csv
import hashlib
import html
import json
import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image

from .ids import Registry, parse_payload
from .scan import file_sequence, list_photos, scan_event
from .sorter import (PORTRAIT, TEAM_PHOTO, Frame, Sorter, SortResult,
                     load_overrides)
from .workspace import Event


def load_roster(path: str | Path | None) -> dict[str, str]:
    """CSV with columns subject_id, team_code (other columns are ignored)."""
    if not path:
        return {}
    out = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            sid = parse_payload(row.get("subject_id", ""))
            team = parse_payload(row.get("team_code", ""))
            if sid.kind == "subject":
                out[sid.code] = team.code if team.kind == "team" else ""
    return out


def build_frames(event: Event, scans) -> list[Frame]:
    frames = []
    for r in scans:
        cam = event.cameras[r.camera]
        t = datetime.fromisoformat(r.capture_time) if r.capture_time else datetime.min
        if r.capture_time:
            t += timedelta(seconds=cam.clock_offset_seconds)
        frames.append(Frame(
            rel_path=r.rel_path, camera=r.camera, role=cam.role, time=t,
            seq=file_sequence(r.rel_path), qr_payloads=list(r.qr_payloads),
            qr_unreadable=r.qr_unreadable, error=r.error, body=r.body,
            time_source=r.time_source,
        ))
    return frames


def sort_event(event: Event, registry: str | Path | None = None, roster: str | Path | None = None,
               link_sorted: bool = False, workers: int | None = None, progress=None) -> SortResult:
    scans = scan_event(event, workers=workers, progress=progress)
    _, unsupported = list_photos(event)
    issued = None
    if registry and Path(registry).exists():
        with Registry(registry) as reg:
            issued = reg.issued()
    cfg = _event_json(event)
    sorter = Sorter(issued=issued, roster=load_roster(roster),
                    overrides=load_overrides(event.overrides),
                    ignore_payloads=set(cfg.get("ignore_qr_payloads", [])),
                    team_photo_gap_minutes=cfg.get("team_photo_gap_minutes", 3.0))
    result = sorter.run(build_frames(event, scans), unsupported)
    write_outputs(event, result, link_sorted=link_sorted)
    return result


def _event_json(event: Event) -> dict:
    return json.loads((event.root / "event.json").read_text())


def write_outputs(event: Event, result: SortResult, link_sorted: bool = False) -> None:
    out = event.output
    out.mkdir(parents=True, exist_ok=True)

    with open(out / "manifest.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["photo", "camera", "capture_time", "frame_type", "team", "subject", "note"])
        for a in result.assignments:
            w.writerow([a.rel_path, a.camera, a.time.isoformat(), a.frame_type, a.team or "", a.subject or "", a.note])

    subjects = result.subjects()
    with open(out / "subjects.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["subject_id", "team", "photos", "first_photo", "last_photo"])
        for sid in sorted(subjects):
            s = subjects[sid]
            w.writerow([sid, s["team"] or "", len(s["photos"]),
                        s["photos"][0] if s["photos"] else "", s["photos"][-1] if s["photos"] else ""])

    teams = result.teams()
    with open(out / "teams.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["team", "kids", "team_photos", "subject_ids"])
        for t in sorted(teams):
            w.writerow([t, len(teams[t]["subjects"]), len(teams[t]["team_photos"]),
                        " ".join(sorted(teams[t]["subjects"]))])

    with open(out / "exceptions.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["exception_id", "type", "camera", "ref", "detail", "photos", "how_to_fix"])
        for e in result.exceptions:
            w.writerow([e.id, e.type, e.camera, e.ref, e.detail, len(e.photos), e.help])

    _write_html(event, result)

    if link_sorted:
        _link_sorted(event, result)


def _thumb(event: Event, rel: str) -> str | None:
    src = event.root / rel
    thumbs = event.output / "thumbs"
    thumbs.mkdir(exist_ok=True)
    name = hashlib.sha1(rel.encode()).hexdigest()[:16] + ".jpg"
    dst = thumbs / name
    if not dst.exists():
        try:
            with Image.open(src) as im:
                im.draft("RGB", (480, 480))
                im = im.convert("RGB")
                im.thumbnail((320, 320))
                im.save(dst, quality=80)
        except Exception:
            return None
    return f"thumbs/{name}"


def _write_html(event: Event, result: SortResult) -> None:
    subjects = result.subjects()
    n_photos = sum(1 for a in result.assignments)
    n_sorted = sum(1 for a in result.assignments if a.frame_type in (PORTRAIT, TEAM_PHOTO))
    esc = html.escape
    parts = [f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exceptions: {esc(event.name)}</title>
<style>
body{{font:15px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#fafafa;color:#1a1a1a;max-width:1100px}}
h1{{font-size:22px;margin:0 0 4px}} .muted{{color:#666}}
.ok{{background:#e7f6ec;border:1px solid #9bd3ad;padding:12px;border-radius:8px}}
.bad{{background:#fdecea;border:1px solid #f1a9a0;padding:12px;border-radius:8px}}
.ex{{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0}}
.ex h3{{margin:0 0 4px;font-size:16px}} code{{background:#f0f0f0;padding:1px 4px;border-radius:4px;word-break:break-all}}
.thumbs{{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}} .thumbs figure{{margin:0;font-size:11px;max-width:160px}}
.thumbs img{{width:160px;height:auto;border-radius:4px;display:block}}
.fix{{font-size:13px;color:#444;margin-top:6px}}
</style></head><body>
<h1>{esc(event.name)}</h1>
<p class="muted">{n_photos} photos &middot; {n_sorted} sorted to a kid or team &middot; {len(subjects)} kids &middot; generated {datetime.now():%Y-%m-%d %H:%M}</p>
"""]
    if not result.exceptions:
        parts.append('<p class="ok"><b>No open exceptions.</b> This event is clear to send to the lab.</p>')
    else:
        parts.append(f'<p class="bad"><b>{len(result.exceptions)} open exception(s).</b> '
                     'Fix each one by adding a line to <code>overrides.csv</code> in the event folder, then run sort again.</p>')
    for e in result.exceptions:
        photos = list(e.photos)
        if (event.root / e.ref).is_file() and e.ref not in photos:
            photos.insert(0, e.ref)  # e.g. the unreadable QR frame itself, so its printed code can be read
        parts.append(f'<div class="ex"><h3>{esc(e.type.replace("_", " ").title().replace(" Id", " ID").replace("Qr ", "QR "))}</h3>'
                     f'<div><code>{esc(e.ref)}</code> {esc(e.camera)} &mdash; {esc(e.detail)}</div>'
                     f'<div class="fix">{esc(e.help)}<br>To accept as-is: <code>{esc(e.id)},accept</code></div>')
        if photos:
            parts.append('<div class="thumbs">')
            for rel in photos[:8]:
                src = _thumb(event, rel)
                if src:
                    parts.append(f'<figure><img src="{esc(src)}" alt=""><figcaption>{esc(Path(rel).name)}</figcaption></figure>')
            if len(photos) > 8:
                parts.append(f'<figure>+{len(photos) - 8} more</figure>')
            parts.append("</div>")
        parts.append("</div>")
    if result.accepted:
        parts.append(f"<h2>Accepted ({len(result.accepted)})</h2><ul>")
        for e in result.accepted:
            parts.append(f"<li><code>{esc(e.id)}</code> {esc(e.detail)}</li>")
        parts.append("</ul>")
    parts.append("</body></html>")
    (event.output / "exceptions.html").write_text("".join(parts))


def _link_sorted(event: Event, result: SortResult) -> None:
    root = event.output / "sorted"
    if root.exists():
        shutil.rmtree(root)
    for a in result.assignments:
        if a.frame_type == PORTRAIT and a.subject:
            dest = root / (a.team or "no-team") / a.subject / Path(a.rel_path).name
        elif a.frame_type == TEAM_PHOTO and a.team:
            dest = root / a.team / "_team" / Path(a.rel_path).name
        else:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest = dest.with_name(f"{a.camera}_{dest.name}")
        src = event.root / a.rel_path
        try:
            os.link(src, dest)  # no extra disk space; originals stay read-only
        except OSError:
            shutil.copy2(src, dest)
