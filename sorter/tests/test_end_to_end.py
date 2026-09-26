"""Phase 1 acceptance, replayed on a synthetic shoot with real JPEGs and QR codes:

* a clean test shoot sorts 100% of frames to the right kid or team, and
* every injected problem shows up in the exceptions report, and
* operator overrides clear them, leaving every photo in the right place.
"""

import csv
from pathlib import Path

import pytest

from photoday.ids import Registry
from photoday.ingest import ingest_card
from photoday.report import sort_event
from photoday.sorter import PORTRAIT, TEAM_PHOTO
from photoday.synth import PROBLEMS, make_shoot
from photoday.workspace import Event


def setup_shoot(tmp_path, problems):
    registry = tmp_path / "registry.db"
    with Registry(registry) as reg:
        ids = reg.issue(12)
    plan = make_shoot(tmp_path / "cards", ids, teams=3, kids_per_team=4, portraits_per_kid=2,
                      problems=problems)
    ev = Event.open(tmp_path / "event", create=True)
    ev.add_camera("indiv", "individuals")
    ev.add_camera("team", "team")
    for cam in ("indiv", "team"):
        ingest_card(ev, tmp_path / "cards" / cam, cam, tmp_path / "backup")
    return ev, plan, registry


def rel(key):
    cam, name = key.split(":")
    return f"originals/{cam}/DCIM/100SYNTH/{name}"


def check_all_correct(res, plan):
    by_path = {a.rel_path: a for a in res.assignments}
    for key, want in plan.expected.items():
        a = by_path[rel(key)]
        if want.startswith("T"):
            assert (a.frame_type, a.team) == (TEAM_PHOTO, want), key
        else:
            assert (a.frame_type, a.subject) == (PORTRAIT, want), key
            assert a.team == next(t for t, kids in plan.teams.items() if want in kids), key
    sorted_photos = [a for a in res.assignments if a.frame_type in (PORTRAIT, TEAM_PHOTO)]
    assert len(sorted_photos) == len(plan.expected)


def test_clean_shoot_sorts_everything(tmp_path):
    ev, plan, registry = setup_shoot(tmp_path, ())
    res = sort_event(ev, registry=registry, link_sorted=True, workers=2)
    assert res.exceptions == []
    check_all_correct(res, plan)
    # outputs
    out = ev.output
    for name in ("manifest.csv", "subjects.csv", "teams.csv", "exceptions.csv", "exceptions.html"):
        assert (out / name).exists()
    subjects = list(csv.DictReader(open(out / "subjects.csv")))
    assert len(subjects) == 12 and all(row["photos"] == "2" for row in subjects)
    first_kid = plan.teams["T01"][0]
    assert len(list((out / "sorted" / "T01" / first_kid).iterdir())) == 2
    assert len(list((out / "sorted" / "T02" / "_team").iterdir())) == 2
    assert "clear to send to the lab" in (out / "exceptions.html").read_text()


def test_every_problem_is_reported_then_fixed(tmp_path):
    ev, plan, registry = setup_shoot(tmp_path, PROBLEMS)
    res = sort_event(ev, registry=registry, workers=2)
    found = {e.type: e for e in res.exceptions}
    p = plan.problems
    assert found["QR_UNREADABLE"].ref == rel(p["unreadable_qr"])
    assert found["PHOTOS_WITHOUT_ID"].ref == rel(p["test_shots"])
    assert found["NO_PHOTOS"].ref == p["kid_without_photos"]
    assert found["UNKNOWN_ID"].ref == p["unissued_id"]
    assert f"most likely {p['missing_team_card']}" in found["TEAM_PHOTO_AFTER_GAP"].detail
    assert found["TEAM_WITHOUT_TEAM_PHOTO"].ref == p["missing_team_card"]
    assert len(res.exceptions) == 6
    assert "6 open exception(s)" in (ev.output / "exceptions.html").read_text()

    # No photo was given to the wrong kid or team, even before fixes.
    by_path = {a.rel_path: a for a in res.assignments}
    for key, want in plan.expected.items():
        a = by_path[rel(key)]
        if want.startswith("T"):
            assert a.team in (None, want), key  # held back or right team, never another team
        else:
            assert a.subject in (None, want), key  # held back or right kid, never another kid

    # The operator fixes everything with overrides.csv and re-runs.
    team2 = plan.teams["T02"]
    ev.overrides.write_text("\n".join([
        "target,action,value,note",
        f"{rel(p['unreadable_qr'])},qr,{team2[1]},read the printed code",
        f"{rel(p['test_shots'])},ignore,,test shot",
        f"NO_PHOTOS:{p['kid_without_photos']},accept,,kid left before photos",
        f"UNKNOWN_ID:{p['unissued_id']},accept,,sticker from old batch",
        f"{found['TEAM_PHOTO_AFTER_GAP'].photos[0]},team,{p['missing_team_card']}",
    ]) + "\n")
    res = sort_event(ev, registry=registry, workers=2)
    assert res.exceptions == [], [e.id for e in res.exceptions]
    assert len(res.accepted) == 2
    check_all_correct(res, plan)


def test_cli_demo_runs(tmp_path, capsys):
    from photoday.cli import main
    main(["demo", str(tmp_path / "demo"), "--teams", "2", "--kids", "3", "--workers", "1"])
    out = capsys.readouterr().out
    assert "OPEN EXCEPTION" in out and "QR_UNREADABLE" in out


def test_cli_ids_and_printing(tmp_path, capsys):
    from photoday.cli import main
    reg = str(tmp_path / "r.db")
    main(["ids", "issue", "--count", "35", "--registry", reg, "--pdf", str(tmp_path / "s.pdf"), "--label", "Spring League"])
    main(["print", "team-cards", "--count", "4", "--out", str(tmp_path / "t.pdf")])
    main(["print", "stickers", "--codes", "A0001-A0003,A0010", "--out", str(tmp_path / "re.pdf"), "--registry", reg])
    with pytest.raises(SystemExit):
        main(["print", "stickers", "--codes", "A0099", "--out", str(tmp_path / "x.pdf"), "--registry", reg])
    for name in ("s.pdf", "t.pdf", "re.pdf"):
        assert (tmp_path / name).read_bytes().startswith(b"%PDF")
    assert "A0001..A0035" in capsys.readouterr().out


def test_printed_qr_decodes(tmp_path):
    """The exact QR image the sticker sheet embeds must decode back to the code."""
    import cv2
    import numpy as np
    from photoday.printing import _qr_image
    for code in ("A0347", "T07"):
        img = _qr_image(code)._image.convert("L")
        text, _, _ = cv2.QRCodeDetector().detectAndDecode(np.array(img))
        assert text == code
