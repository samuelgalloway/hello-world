"""Command line: ``photoday <command>``. Run ``photoday -h`` for the list."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from . import printing
from .ids import Registry, parse_payload, team_codes

DEFAULT_REGISTRY = os.environ.get("PHOTODAY_REGISTRY", str(Path.home() / ".photoday" / "registry.db"))


def _progress(label: str):
    def show(done: int, total: int):
        if sys.stderr.isatty():
            print(f"\r{label}: {done}/{total}", end="" if done < total else "\n", file=sys.stderr)
    return show


def _expand_codes(spec: str) -> list[str]:
    """``A0001-A0030,B0005`` -> list of codes."""
    out = []
    for part in spec.split(","):
        part = part.strip().upper()
        if "-" in part:
            a, b = part.split("-", 1)
            if a[0] != b[0] or parse_payload(a).kind != "subject" or parse_payload(b).kind != "subject":
                raise SystemExit(f"bad range {part!r}")
            out += [f"{a[0]}{n:04d}" for n in range(int(a[1:]), int(b[1:]) + 1)]
        elif part:
            if parse_payload(part).kind != "subject":
                raise SystemExit(f"not a Subject ID: {part!r}")
            out.append(part)
    return out


def cmd_ids_issue(a):
    with Registry(a.registry) as reg:
        codes = reg.issue(a.count, owner=a.owner, prefix=a.prefix)
    print(f"Issued {len(codes)} Subject IDs: {codes[0]}..{codes[-1]} (owner: {a.owner})")
    if a.pdf:
        printing.sticker_sheet(codes, a.pdf, a.label)
        print(f"Sticker sheet: {a.pdf}")


def cmd_ids_list(a):
    with Registry(a.registry) as reg:
        rows = reg.batches()
    if not rows:
        print("No IDs issued yet.")
    for batch, owner, n, lo, hi in rows:
        print(f"{batch[:19]}  {owner:<16} {n:>5}  {lo}..{hi}")


def cmd_print_stickers(a):
    codes = _expand_codes(a.codes)
    with Registry(a.registry) as reg:
        missing = [c for c in codes if not reg.is_issued(c)]
    if missing and not a.force:
        raise SystemExit(f"{len(missing)} code(s) were never issued (e.g. {missing[0]}); issue them first or pass --force")
    printing.sticker_sheet(codes, a.out, a.label)
    print(f"{len(codes)} stickers -> {a.out}")


def cmd_print_team_cards(a):
    printing.team_cards(team_codes(a.count), a.out)
    print(f"Team cards T01..T{a.count:02d} -> {a.out}")


def cmd_event_init(a):
    from .workspace import Event
    ev = Event.open(a.dir, create=True)
    if a.name:
        ev.name = a.name
        ev.save()
    for spec in a.camera or []:
        name, _, role = spec.partition("=")
        ev.add_camera(name, role)
    for spec in a.offset or []:
        name, _, secs = spec.partition("=")
        if name not in ev.cameras:
            raise SystemExit(f"unknown camera {name!r}")
        ev.add_camera(name, ev.cameras[name].role, float(secs))
    print(f"Event {ev.name!r} at {ev.root}")
    for c in ev.cameras.values():
        print(f"  camera {c.name}: {c.role} (clock offset {c.clock_offset_seconds:+g}s)")


def cmd_ingest(a):
    from .ingest import ingest_card
    from .workspace import Event
    ev = Event.open(a.dir)
    r = ingest_card(ev, a.card, a.camera, a.backup, progress=_progress("ingest"))
    print(f"Copied {r.copied} file(s) ({r.bytes / 1e9:.2f} GB) to 2 places, verified; "
          f"{r.skipped_existing} already ingested; {r.renamed} renamed to avoid a name clash.")
    print("Safe to format this card." if r.copied or r.skipped_existing else "Nothing found on the card.")


def cmd_sort(a):
    from .report import sort_event
    from .workspace import Event
    ev = Event.open(a.dir)
    res = sort_event(ev, registry=a.registry, roster=a.roster, link_sorted=a.link_sorted,
                     workers=a.workers, progress=_progress("scan"))
    _summary(ev, res)
    return 1 if res.exceptions else 0


def _summary(ev, res):
    from collections import Counter
    types = Counter(x.frame_type for x in res.assignments)
    print(f"{len(res.assignments)} photos: " + ", ".join(f"{n} {t}" for t, n in sorted(types.items())))
    print(f"{len(res.subjects())} kids across {len(res.teams())} teams")
    if res.exceptions:
        print(f"\n{len(res.exceptions)} OPEN EXCEPTION(S) - not ready for the lab:")
        for e in res.exceptions:
            print(f"  {e.type:<26} {e.ref:<40} {e.detail}")
    else:
        print("\nNo open exceptions - ready for the lab.")
    if res.accepted:
        print(f"({len(res.accepted)} accepted)")
    print(f"\nReport: {ev.output / 'exceptions.html'}")


def cmd_demo(a):
    from .ingest import ingest_card
    from .report import sort_event
    from .synth import PROBLEMS, make_shoot
    from .workspace import Event
    root = Path(a.dir)
    if root.exists() and any(root.iterdir()):
        raise SystemExit(f"{root} is not empty")
    registry = root / "registry.db"
    with Registry(registry) as reg:
        ids = reg.issue(a.teams * a.kids, owner="demo")
    problems = PROBLEMS if a.problems else ()
    plan = make_shoot(root / "cards", ids, teams=a.teams, kids_per_team=a.kids, problems=problems)
    ev = Event.open(root / "event", create=True)
    ev.add_camera("indiv", "individuals")
    ev.add_camera("team", "team")
    for cam in ("indiv", "team"):
        ingest_card(ev, root / "cards" / cam, cam, root / "backup")
    res = sort_event(ev, registry=registry, workers=a.workers, progress=_progress("scan"))
    if problems:
        print("Injected problems: " + ", ".join(f"{k} ({v})" for k, v in plan.problems.items()) + "\n")
    _summary(ev, res)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="photoday", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    ids = sub.add_parser("ids", help="issue and list Subject IDs").add_subparsers(dest="ids_cmd", required=True)
    s = ids.add_parser("issue", help="reserve new, never-used Subject IDs")
    s.add_argument("--count", type=int, required=True)
    s.add_argument("--owner", default="stickers", help="who holds the block, e.g. stickers or device:TAB1")
    s.add_argument("--prefix", help="restrict to one prefix letter")
    s.add_argument("--pdf", help="also write a sticker sheet PDF")
    s.add_argument("--label", default="", help="small text on each sticker, e.g. league name")
    s.add_argument("--registry", default=DEFAULT_REGISTRY)
    s.set_defaults(func=cmd_ids_issue)
    s = ids.add_parser("list", help="show issued batches")
    s.add_argument("--registry", default=DEFAULT_REGISTRY)
    s.set_defaults(func=cmd_ids_list)

    pr = sub.add_parser("print", help="printable PDFs").add_subparsers(dest="print_cmd", required=True)
    s = pr.add_parser("stickers", help="(re)print sticker sheets for issued IDs")
    s.add_argument("--codes", required=True, help="e.g. A0001-A0300 or A0001,A0007")
    s.add_argument("--out", required=True)
    s.add_argument("--label", default="")
    s.add_argument("--force", action="store_true", help="print codes the registry never issued")
    s.add_argument("--registry", default=DEFAULT_REGISTRY)
    s.set_defaults(func=cmd_print_stickers)
    s = pr.add_parser("team-cards", help="reusable team cards T01..Tnn")
    s.add_argument("--count", type=int, default=60)
    s.add_argument("--out", required=True)
    s.set_defaults(func=cmd_print_team_cards)

    ev = sub.add_parser("event", help="event workspace").add_subparsers(dest="event_cmd", required=True)
    s = ev.add_parser("init", help="create or update an event workspace")
    s.add_argument("dir")
    s.add_argument("--name")
    s.add_argument("--camera", action="append", metavar="NAME=ROLE", help="role: individuals or team")
    s.add_argument("--offset", action="append", metavar="NAME=SECONDS", help="add to this camera's clock")
    s.set_defaults(func=cmd_event_init)

    s = sub.add_parser("ingest", help="copy a memory card to the workspace and a second backup, verified")
    s.add_argument("dir", help="event workspace")
    s.add_argument("--card", required=True, help="mounted card folder")
    s.add_argument("--camera", required=True)
    s.add_argument("--backup", required=True, help="second backup root (another drive)")
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("sort", help="scan, sort, and write the manifest and exceptions report")
    s.add_argument("dir", help="event workspace")
    s.add_argument("--registry", default=DEFAULT_REGISTRY)
    s.add_argument("--roster", help="CSV with subject_id,team_code (check-in data)")
    s.add_argument("--link-sorted", action="store_true", help="also build output/sorted/<team>/<kid>/")
    s.add_argument("--workers", type=int)
    s.set_defaults(func=cmd_sort)

    s = sub.add_parser("demo", help="replay a synthetic test shoot end to end")
    s.add_argument("dir")
    s.add_argument("--teams", type=int, default=3)
    s.add_argument("--kids", type=int, default=4)
    s.add_argument("--no-problems", dest="problems", action="store_false")
    s.add_argument("--workers", type=int)
    s.set_defaults(func=cmd_demo)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
