"""The sorting rule, plus every check that turns a problem into an exception.

Rule (per camera, in capture order):
  * a team QR sets the current team (and ends the current kid),
  * a subject QR sets the current kid,
  * every other photo belongs to the current kid (individuals camera) or the
    current team (team camera) until the next QR.

The sorter never guesses when it could be wrong. Anything ambiguous leaves the
photo unassigned and raises an exception; the operator fixes it with a line in
``overrides.csv`` and re-runs. Exceptions must be empty before a lab batch.

This module is pure (no file I/O) so it can be tested with synthetic frames.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from .ids import parse_payload

# Frame types
TEAM_CARD = "team_card"
SUBJECT_QR = "subject_qr"
PORTRAIT = "portrait"
TEAM_PHOTO = "team_photo"
QR_UNREADABLE = "qr_unreadable"
UNASSIGNED = "unassigned"
IGNORED = "ignored"
BAD_FILE = "bad_file"

# Exception types, with the fix the operator should make
EXCEPTION_HELP = {
    "QR_UNREADABLE": "A QR frame could not be read, so the photos after it are held back. Read the code printed under the QR and add: <photo>,qr,<CODE>",
    "PHOTOS_WITHOUT_ID": "Photos with no kid QR before them. Assign each with: <photo>,subject,<ID>  (or ignore test shots with: <photo>,ignore)",
    "TEAM_PHOTO_WITHOUT_TEAM": "Team-camera photos with no team card before them. Check the suggested team, then add: <first photo>,team,<Txx> (acts like a team card just before it)",
    "TEAM_PHOTO_AFTER_GAP": "Team photos taken long after the rest of their team's run, so another team's card was probably missed. Check the suggested team, then add: <first photo>,team,<Txx> (use the earlier team to keep them there)",
    "SUBJECT_WITHOUT_TEAM": "A kid was shot before any team card on the individuals camera. Add: <kid's QR photo>,team,<Txx> (acts like a team card just before it), or accept if the roster has the team.",
    "NO_PHOTOS": "A kid was checked in or scanned but has no photos. Find the photos and assign them, or accept if the kid left.",
    "UNKNOWN_ID": "A Subject ID that was never issued. Check for a misprint, or accept it.",
    "SUBJECT_IN_TWO_TEAMS": "The same kid appears under two teams. Fix the wrong QR frame, or accept (e.g. a kid on two teams).",
    "TEAM_MISMATCH": "The team card before this kid differs from the roster team. Fix the roster or the frame.",
    "MULTIPLE_IDS": "More than one kid QR in one frame. Fix with: <photo>,qr,<CODE>",
    "SUBJECT_QR_ON_TEAM_CAMERA": "A kid QR on the team camera. Accept if harmless.",
    "FOREIGN_QR": "A QR that isn't one of ours. Add it to ignore_qr_payloads in event.json if it's background (a banner), or fix with <photo>,qr,<CODE>.",
    "TEAM_WITHOUT_TEAM_PHOTO": "Team has individuals but no team photo. Find the team photo or accept.",
    "TEAM_WITHOUT_INDIVIDUALS": "Team photo with no individuals for that team. Check the team card, or accept.",
    "CLOCK_CHECK": "Team photo time is far from that team's individuals time. Check camera clocks and the team card.",
    "NO_EXIF_TIME": "No capture time in the file, so ordering is uncertain. Check where this photo belongs and assign it.",
    "MIXED_BODIES": "Photos from more than one camera body in one camera folder. Re-ingest cards under the right camera.",
    "UNREADABLE_FILE": "The file could not be read (corrupt?), and photos after it are held back. Check the card copy.",
    "UNSUPPORTED_FILE": "A file that isn't a JPEG (and has no JPEG pair). Accept or convert it.",
    "MANY_PHOTOS": "Far more photos than other kids, so another kid's QR frame may have been missed and two kids merged. Check the photos; assign the other kid's with <photo>,subject,<ID>, or accept.",
    "NOT_PHOTOGRAPHED": "On the roster but never scanned on camera. Accept if absent.",
}


@dataclass
class Frame:
    rel_path: str
    camera: str
    role: str  # "individuals" or "team"
    time: datetime
    seq: int = -1
    qr_payloads: list[str] = field(default_factory=list)
    qr_unreadable: bool = False
    error: str | None = None
    body: str = ""
    time_source: str = "exif"


@dataclass
class Assignment:
    rel_path: str
    camera: str
    time: datetime
    frame_type: str
    team: str | None = None
    subject: str | None = None
    note: str = ""


@dataclass
class SortException:
    type: str
    ref: str  # photo path, subject ID, or team code
    camera: str = ""
    detail: str = ""
    photos: list[str] = field(default_factory=list)

    @property
    def id(self) -> str:
        return f"{self.type}:{self.ref}"

    @property
    def help(self) -> str:
        return EXCEPTION_HELP.get(self.type, "")


@dataclass
class Override:
    target: str  # photo rel_path, or an exception id
    action: str  # qr | subject | team | ignore | accept
    value: str = ""
    note: str = ""


@dataclass
class SortResult:
    assignments: list[Assignment]
    exceptions: list[SortException]
    accepted: list[SortException]

    def subjects(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for a in self.assignments:
            if a.subject and a.frame_type in (PORTRAIT, SUBJECT_QR):
                s = out.setdefault(a.subject, {"team": a.team, "photos": [], "qr_frames": 0})
                if a.team and not s["team"]:
                    s["team"] = a.team
                if a.frame_type == PORTRAIT:
                    s["photos"].append(a.rel_path)
                else:
                    s["qr_frames"] += 1
        return out

    def teams(self) -> dict[str, dict]:
        out: dict[str, dict] = defaultdict(lambda: {"subjects": set(), "team_photos": []})
        for a in self.assignments:
            if a.team and a.frame_type == PORTRAIT and a.subject:
                out[a.team]["subjects"].add(a.subject)
            elif a.team and a.frame_type == TEAM_PHOTO:
                out[a.team]["team_photos"].append(a.rel_path)
        return dict(out)


VALID_ACTIONS = {"qr", "subject", "team", "ignore", "accept"}


def load_overrides(path: Path) -> list[Override]:
    if not path.exists():
        return []
    out = []
    with open(path, newline="") as f:
        for row in csv.reader(f):
            if not row or not row[0].strip() or row[0].lstrip().startswith("#"):
                continue
            if row[0].strip() == "target":
                continue  # header
            target, action = row[0].strip(), (row[1].strip().lower() if len(row) > 1 else "")
            value = row[2].strip() if len(row) > 2 else ""
            note = row[3].strip() if len(row) > 3 else ""
            if action not in VALID_ACTIONS:
                raise ValueError(f"overrides.csv: unknown action {action!r} for {target}")
            out.append(Override(target, action, value, note))
    return out


class _CameraRun:
    """Walks one camera's frames in capture order, applying the sorting rule."""

    BLOCKED = object()

    def __init__(self, sorter: "Sorter", camera: str, role: str):
        self.s = sorter
        self.camera = camera
        self.role = role
        self.team: str | None = None
        self.subject = None  # str, None, or BLOCKED
        self.block_frame: str | None = None
        self.block_type = "QR_UNREADABLE"
        self.pending: list[str] = []  # photos in the current problem run
        self.pending_kind: str | None = None
        self.last_team_photo: datetime | None = None
        self.gap_held = False

    # -- helpers ---------------------------------------------------------
    def flush(self):
        if not self.pending:
            return
        if self.pending_kind == "blocked":
            ex = self.s.exceptions_by_id.get(f"{self.block_type}:{self.block_frame}")
            if ex:
                ex.photos.extend(self.pending)
                ex.detail = f"{len(ex.photos)} photo(s) after it are held back"
        elif self.pending_kind == "no_id":
            self.s.add("PHOTOS_WITHOUT_ID", self.pending[0], self.camera,
                       f"{len(self.pending)} photo(s)" + (f" after team card {self.team}" if self.team else ""),
                       list(self.pending))
        elif self.pending_kind == "no_team":
            self.s.no_team_runs.append((self.camera, list(self.pending), "TEAM_PHOTO_WITHOUT_TEAM", None))
        elif self.pending_kind == "gap":
            self.s.no_team_runs.append((self.camera, list(self.pending), "TEAM_PHOTO_AFTER_GAP", self.team))
        self.pending, self.pending_kind = [], None

    def hold(self, kind: str, rel: str):
        if self.pending_kind != kind:
            self.flush()
            self.pending_kind = kind
        self.pending.append(rel)

    def set_team(self, team: str):
        self.flush()
        self.team = team
        self.subject = None
        self.last_team_photo = None
        self.gap_held = False

    def block(self, frame: Frame, ex_type: str, detail: str):
        self.flush()
        self.s.add(ex_type, frame.rel_path, self.camera, detail)
        self.subject = self.BLOCKED
        self.block_frame = frame.rel_path
        self.block_type = ex_type

    # -- main step -------------------------------------------------------
    def step(self, f: Frame):
        s = self.s
        ov = s.photo_overrides.get(f.rel_path)
        if ov and ov.action == "qr":
            f.qr_payloads, f.qr_unreadable, f.error = [ov.value], False, None
        elif ov and ov.action == "team":
            # Acts like a team card shot just before this frame (on either camera).
            self.set_team(_team_code(ov.value))
        elif ov and ov.action in ("subject", "ignore"):
            self.direct(f, ov)
            return

        if f.error:
            s.assign(f, BAD_FILE, note=f.error)
            self.block(f, "UNREADABLE_FILE", f.error)
            return
        if f.time_source != "exif":
            s.add("NO_EXIF_TIME", f.rel_path, self.camera, "ordered by file time instead")

        codes = [parse_payload(p) for p in f.qr_payloads if p not in s.ignore_payloads]
        teams = sorted({c.code for c in codes if c.kind == "team"})
        subjects = sorted({c.code for c in codes if c.kind == "subject"})
        foreign = [c.code for c in codes if c.kind == "foreign"]

        if foreign and not teams and not subjects:
            s.add("FOREIGN_QR", f.rel_path, self.camera, f"payload: {foreign[0][:60]!r}")
            # fall through: treat as an ordinary photo, but it stays flagged
        if len(teams) > 1 or len(subjects) > 1:
            s.assign(f, UNASSIGNED, note="multiple codes")
            self.block(f, "MULTIPLE_IDS", ", ".join(teams + subjects))
            return
        if teams:
            self.set_team(teams[0])
            s.assign(f, TEAM_CARD, team=self.team)
            s.team_card_times[self.role][self.team].append(f.time)
            if not subjects:
                return
        if subjects:
            self.flush()
            if self.role == "team":
                s.assign(f, UNASSIGNED, team=self.team, note="kid QR on team camera")
                s.add("SUBJECT_QR_ON_TEAM_CAMERA", f.rel_path, self.camera, subjects[0])
                return
            self.set_subject(f, subjects[0])
            return
        if f.qr_unreadable and not foreign:
            s.assign(f, QR_UNREADABLE, team=self.team)
            self.block(f, "QR_UNREADABLE", "QR detected but not readable")
            return

        # An ordinary photo
        if self.role == "team":
            # Team photos come in a quick burst. A long gap inside one team's
            # run means the next team's card was probably missed: hold the rest.
            if (self.team and not self.gap_held and self.last_team_photo is not None
                    and f.time - self.last_team_photo > s.team_photo_gap):
                self.gap_held = True
            if self.team and not self.gap_held:
                s.assign(f, TEAM_PHOTO, team=self.team)
                self.last_team_photo = f.time
            elif self.team:
                s.assign(f, UNASSIGNED, team=None, note=f"held: long gap after {self.team} photos")
                self.hold("gap", f.rel_path)
            else:
                s.assign(f, UNASSIGNED)
                self.hold("no_team", f.rel_path)
            return
        if self.subject is self.BLOCKED:
            s.assign(f, UNASSIGNED, team=self.team, note=f"held: after {self.block_frame}")
            self.hold("blocked", f.rel_path)
        elif self.subject:
            s.assign(f, PORTRAIT, team=self.team, subject=self.subject)
        else:
            s.assign(f, UNASSIGNED, team=self.team)
            self.hold("no_id", f.rel_path)

    def set_subject(self, f: Frame, code: str):
        s = self.s
        self.subject = code
        s.assign(f, SUBJECT_QR, team=self.team, subject=code)
        s.subject_seen.setdefault(code, f.rel_path)
        if self.team is None:
            s.add("SUBJECT_WITHOUT_TEAM", f.rel_path, self.camera, f"{code} scanned before any team card")
        else:
            s.subject_teams[code].add(self.team)
        if s.issued is not None and code not in s.issued:
            s.add("UNKNOWN_ID", code, self.camera, f"first seen in {f.rel_path}")

    def direct(self, f: Frame, ov: Override):
        """Operator override on a single photo: it doesn't change the running state."""
        s = self.s
        if ov.action == "ignore":
            s.assign(f, IGNORED, note=ov.note or "ignored by operator")
        elif ov.action == "subject":
            sub = parse_payload(ov.value)
            if sub.kind != "subject":
                raise ValueError(f"overrides.csv: {ov.value!r} is not a Subject ID")
            s.assign(f, PORTRAIT, subject=sub.code, team=None, note="operator")


class Sorter:
    def __init__(self, issued: set[str] | None = None, roster: dict[str, str] | None = None,
                 overrides: list[Override] | None = None, ignore_payloads: set[str] | None = None,
                 team_photo_gap_minutes: float = 3.0):
        self.issued = issued
        self.roster = roster or {}
        self.overrides = overrides or []
        self.photo_overrides = {o.target: o for o in self.overrides if o.action != "accept"}
        self.accepted_ids = {o.target for o in self.overrides if o.action == "accept"}
        self.ignore_payloads = ignore_payloads or set()
        self.team_photo_gap = timedelta(minutes=team_photo_gap_minutes)
        self.assignments: dict[str, Assignment] = {}
        self.exceptions_by_id: dict[str, SortException] = {}
        self.subject_seen: dict[str, str] = {}
        self.subject_teams: dict[str, set[str]] = defaultdict(set)
        self.team_card_times: dict[str, dict[str, list[datetime]]] = {
            "individuals": defaultdict(list), "team": defaultdict(list)}
        self.no_team_runs: list[tuple[str, list[str]]] = []

    def add(self, type_: str, ref: str, camera: str = "", detail: str = "", photos=None):
        ex = SortException(type_, ref, camera, detail, list(photos or []))
        if ex.id not in self.exceptions_by_id:
            self.exceptions_by_id[ex.id] = ex
        return self.exceptions_by_id[ex.id]

    def assign(self, f: Frame, frame_type: str, team=None, subject=None, note=""):
        self.assignments[f.rel_path] = Assignment(f.rel_path, f.camera, f.time, frame_type, team, subject, note)

    def run(self, frames: list[Frame], unsupported: list[tuple[str, str]] = ()) -> SortResult:
        by_cam: dict[str, list[Frame]] = defaultdict(list)
        for f in frames:
            by_cam[f.camera].append(f)
        for cam, fs in sorted(by_cam.items()):
            fs.sort(key=lambda f: (f.time, f.seq, f.rel_path))
            bodies = {f.body for f in fs if f.body}
            if len(bodies) > 1:
                self.add("MIXED_BODIES", cam, cam, "; ".join(sorted(bodies)))
            run = _CameraRun(self, cam, fs[0].role)
            for f in fs:
                run.step(f)
            run.flush()
        for cam, rel in unsupported:
            self.add("UNSUPPORTED_FILE", rel, cam)
        self._post_checks(frames)
        ordered = sorted(self.assignments.values(), key=lambda a: (a.camera, a.time, a.rel_path))
        open_, accepted = [], []
        for ex in self.exceptions_by_id.values():
            (accepted if ex.id in self.accepted_ids else open_).append(ex)
        key = lambda e: (e.type, e.camera, e.ref)
        return SortResult(ordered, sorted(open_, key=key), sorted(accepted, key=key))

    # -- checks after all cameras are sorted -------------------------------
    def _post_checks(self, frames: list[Frame]):
        subject_photos: dict[str, int] = defaultdict(int)
        for a in self.assignments.values():
            if a.frame_type == PORTRAIT and a.subject:
                subject_photos[a.subject] += 1

        # A missed QR frame merges two kids into one: that kid ends up with
        # about twice the usual number of photos. Flag clear outliers.
        counts = sorted(n for n in subject_photos.values() if n > 0)
        if len(counts) >= 5:
            median = counts[len(counts) // 2]
            limit = max(2 * median, median + 4)
            for code, n in sorted(subject_photos.items()):
                if n >= limit:
                    self.add("MANY_PHOTOS", code, detail=f"{n} photos (typical: {median}); a kid's QR frame may be missing")

        for code, first in self.subject_seen.items():
            if subject_photos[code] == 0:
                self.add("NO_PHOTOS", code, detail=f"QR frame {first} has no photos after it")
            teams = self.subject_teams.get(code, set())
            if len(teams) > 1:
                self.add("SUBJECT_IN_TWO_TEAMS", code, detail=", ".join(sorted(teams)))
            roster_team = self.roster.get(code)
            if roster_team and teams and roster_team not in teams:
                self.add("TEAM_MISMATCH", code, detail=f"roster {roster_team}, shot under {', '.join(sorted(teams))}")
        for code, team in sorted(self.roster.items()):
            if code not in self.subject_seen and subject_photos[code] == 0:
                self.add("NOT_PHOTOGRAPHED", code, detail=f"roster team {team}")
        # Photos an operator assigned to a kid, or a kid with no team card: take
        # the kid's team from the camera, else from the roster.
        for a in self.assignments.values():
            if a.subject and a.team is None:
                teams = self.subject_teams.get(a.subject, set())
                if len(teams) == 1:
                    a.team = next(iter(teams))
                elif self.roster.get(a.subject):
                    a.team = self.roster[a.subject]

        # Team windows on the individuals camera, for the time backup link.
        roles = {f.camera: f.role for f in frames}
        has_team_cam = "team" in roles.values()
        has_indiv_cam = "individuals" in roles.values()
        windows: dict[str, list[datetime]] = defaultdict(list)
        for a in self.assignments.values():
            if a.team and a.frame_type in (TEAM_CARD, SUBJECT_QR, PORTRAIT) and roles.get(a.camera) == "individuals":
                windows[a.team].append(a.time)
        spans = {t: (min(v), max(v)) for t, v in windows.items()}

        team_photo_teams = {a.team for a in self.assignments.values() if a.frame_type == TEAM_PHOTO}
        for t in sorted(spans):
            if t not in team_photo_teams and has_team_cam:
                self.add("TEAM_WITHOUT_TEAM_PHOTO", t)
        for t in sorted(team_photo_teams):
            if t not in spans and has_indiv_cam:
                self.add("TEAM_WITHOUT_INDIVIDUALS", t)

        # Clock check: team camera's team card should sit near that team's individuals.
        for t, times in self.team_card_times["team"].items():
            if t in spans:
                start, end = spans[t]
                for tt in times:
                    if tt < start - timedelta(minutes=45) or tt > end + timedelta(minutes=90):
                        self.add("CLOCK_CHECK", t, detail=(
                            f"team card at {tt:%H:%M:%S}, individuals {start:%H:%M}-{end:%H:%M}"))
                        break

        for cam, photos, ex_type, prev_team in self.no_team_runs:
            t0 = self.assignments[photos[0]].time
            suggestion = _suggest_team(spans, t0)
            detail = f"{len(photos)} photo(s)"
            if prev_team:
                detail += f" long after the last {prev_team} photo; a team card may have been missed"
            if suggestion:
                detail += f"; by time, most likely {suggestion}"
            self.add(ex_type, photos[0], cam, detail, photos)


def _team_code(value: str) -> str:
    team = parse_payload(value)
    if team.kind != "team":
        raise ValueError(f"overrides.csv: {value!r} is not a team code")
    return team.code


def _suggest_team(spans: dict[str, tuple[datetime, datetime]], t: datetime) -> str | None:
    """Team photos are shot right after individuals: prefer the latest team that
    finished before ``t``; otherwise the team whose window is nearest."""
    if not spans:
        return None
    before = [(t - end, team) for team, (start, end) in spans.items() if end <= t]
    if before:
        return min(before)[1]
    return min((abs(start - t), team) for team, (start, _end) in spans.items())[1]
