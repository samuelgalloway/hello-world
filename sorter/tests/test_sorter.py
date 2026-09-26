"""Unit tests of the sorting rule on synthetic frames (no images needed)."""

from datetime import datetime, timedelta

from photoday.sorter import (PORTRAIT, TEAM_PHOTO, UNASSIGNED, Frame, Override,
                             Sorter)

T0 = datetime(2026, 10, 3, 9, 0, 0)


class Cam:
    """Builds frames for one camera, one second apart unless told otherwise."""

    def __init__(self, name="indiv", role="individuals", start=T0):
        self.name, self.role, self.t, self.n, self.frames = name, role, start, 0, []

    def shot(self, qr=None, unreadable=False, gap=1, **kw):
        self.t += timedelta(seconds=gap)
        self.n += 1
        rel = f"{self.name}/IMG_{self.n:04d}.JPG"
        self.frames.append(Frame(rel, self.name, self.role, self.t, self.n,
                                 [qr] if qr else [], unreadable, **kw))
        return rel

    def photos(self, k, **kw):
        return [self.shot(**kw) for _ in range(k)]


def sort(*cams, **kw):
    frames = [f for c in cams for f in c.frames]
    return Sorter(**kw).run(frames)


def where(res, rel):
    return next(a for a in res.assignments if a.rel_path == rel)


def types(res):
    return sorted(e.type for e in res.exceptions)


def test_basic_rule_and_clean_run():
    ind, team = Cam(), Cam("team", "team")
    ind.shot("T01")
    ind.shot("A0001"); a = ind.photos(3)
    ind.shot("A0002"); b = ind.photos(2)
    team.t = ind.t
    team.shot("T01"); tp = team.photos(2)
    res = sort(ind, team)
    assert res.exceptions == []
    assert all(where(res, r).subject == "A0001" and where(res, r).team == "T01" for r in a)
    assert all(where(res, r).subject == "A0002" for r in b)
    assert all(where(res, r).frame_type == TEAM_PHOTO and where(res, r).team == "T01" for r in tp)
    assert res.teams()["T01"]["subjects"] == {"A0001", "A0002"}


def test_capture_order_not_file_order():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001")
    p = ind.shot()
    ind.frames.reverse()  # arrive out of order
    res = sort(ind)
    assert where(res, p).subject == "A0001"


def test_unreadable_qr_holds_following_photos():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.photos(2)
    bad = ind.shot(unreadable=True); held = ind.photos(3)
    ind.shot("A0003"); ok = ind.photos(1)
    res = sort(ind)
    ex = next(e for e in res.exceptions if e.type == "QR_UNREADABLE")
    assert ex.ref == bad and ex.photos == held
    # never given to the previous kid
    assert all(where(res, r).frame_type == UNASSIGNED for r in held)
    assert where(res, ok[0]).subject == "A0003"


def test_qr_override_fixes_unreadable_frame():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.photos(2)
    bad = ind.shot(unreadable=True); held = ind.photos(3)
    res = sort(ind, overrides=[Override(bad, "qr", "A0002")])
    assert res.exceptions == []
    assert all(where(res, r).subject == "A0002" and where(res, r).team == "T01" for r in held)


def test_photos_before_any_kid():
    ind = Cam()
    ind.shot("T01"); stray = ind.photos(2); ind.shot("A0001"); ind.photos(1)
    res = sort(ind)
    assert types(res) == ["PHOTOS_WITHOUT_ID"]
    assert res.exceptions[0].photos == stray
    fixed = sort(ind, overrides=[Override(stray[0], "ignore"), Override(stray[1], "subject", "A0001")])
    assert fixed.exceptions == []
    assert where(fixed, stray[1]).subject == "A0001" and where(fixed, stray[1]).team == "T01"


def test_kid_with_no_photos_and_accept():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.shot("A0002"); ind.photos(2)
    res = sort(ind)
    assert types(res) == ["NO_PHOTOS"] and res.exceptions[0].ref == "A0001"
    res = sort(ind, overrides=[Override("NO_PHOTOS:A0001", "accept")])
    assert res.exceptions == [] and [e.id for e in res.accepted] == ["NO_PHOTOS:A0001"]


def test_team_card_ends_current_kid():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.photos(1)
    ind.shot("T02"); stray = ind.photos(1)
    res = sort(ind)
    assert where(res, stray[0]).frame_type == UNASSIGNED
    assert types(res) == ["PHOTOS_WITHOUT_ID"]


def test_multiple_ids_in_one_frame():
    ind = Cam()
    ind.shot("T01")
    ind.n += 1
    ind.t += timedelta(seconds=1)
    ind.frames.append(Frame("indiv/two.JPG", "indiv", "individuals", ind.t, ind.n, ["A0001", "A0002"]))
    held = ind.photos(2)
    res = sort(ind)
    assert "MULTIPLE_IDS" in types(res)
    assert all(where(res, r).frame_type == UNASSIGNED for r in held)


def test_team_plus_subject_in_one_frame_is_fine():
    ind = Cam()
    ind.n += 1
    ind.frames.append(Frame("indiv/both.JPG", "indiv", "individuals", T0, 1, ["T01", "A0001"]))
    ind.t = T0
    p = ind.photos(1)
    res = sort(ind)
    assert res.exceptions == []
    assert where(res, p[0]).team == "T01" and where(res, p[0]).subject == "A0001"


def test_subject_without_team_and_team_override():
    ind = Cam()
    qr = ind.shot("A0001"); p = ind.photos(2)
    res = sort(ind)
    assert types(res) == ["SUBJECT_WITHOUT_TEAM"]
    res = sort(ind, overrides=[Override(qr, "team", "T05")])
    assert res.exceptions == []
    assert all(where(res, r).team == "T05" for r in p)


def test_roster_fills_team_and_detects_mismatch():
    ind = Cam()
    ind.shot("A0001"); p = ind.photos(1)
    res = sort(ind, roster={"A0001": "T02"}, overrides=[Override("SUBJECT_WITHOUT_TEAM:indiv/IMG_0001.JPG", "accept")])
    assert res.exceptions == [] and where(res, p[0]).team == "T02"

    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.photos(1)
    res = sort(ind, roster={"A0001": "T02", "A0009": "T01"})
    assert types(res) == ["NOT_PHOTOGRAPHED", "TEAM_MISMATCH"]


def test_unknown_id_and_two_teams():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.photos(1)
    ind.shot("T02"); ind.shot("A0001"); ind.photos(1)
    ind.shot("B0001"); ind.photos(1)
    res = sort(ind, issued={"A0001"})
    assert types(res) == ["SUBJECT_IN_TWO_TEAMS", "UNKNOWN_ID"]


def test_foreign_qr_flagged_or_ignored():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); p = ind.shot("https://sponsor.example.com")
    res = sort(ind)
    assert types(res) == ["FOREIGN_QR"]
    assert where(res, p).subject == "A0001"  # stays with the kid
    res = sort(ind, ignore_payloads={"https://sponsor.example.com"})
    assert res.exceptions == []


def test_team_camera_without_card_suggests_team_by_time():
    ind, team = Cam(), Cam("team", "team")
    ind.shot("T01"); ind.shot("A0001"); ind.photos(2)
    t1_end = ind.t
    ind.shot("T02", gap=600); ind.shot("A0002"); ind.photos(2)
    team.t = t1_end + timedelta(seconds=30)
    held = team.photos(2)  # card for T01 forgotten
    team.t = ind.t
    team.shot("T02"); team.photos(1)
    res = sort(ind, team)
    ex = next(e for e in res.exceptions if e.type == "TEAM_PHOTO_WITHOUT_TEAM")
    assert ex.photos == held and "most likely T01" in ex.detail
    res = sort(ind, team, overrides=[Override(held[0], "team", "T01")])
    assert res.exceptions == []
    assert all(where(res, r).team == "T01" for r in held)


def test_missed_team_card_caught_by_gap():
    ind, team = Cam(), Cam("team", "team")
    ind.shot("T01"); ind.shot("A0001"); ind.photos(1)
    ind.shot("T02", gap=300); ind.shot("A0002"); ind.photos(1)
    team.t = T0 + timedelta(seconds=60)
    team.shot("T01"); t1 = team.photos(2)
    team.t = ind.t + timedelta(seconds=30)
    t2 = team.photos(2)  # T02's card was not shot on the team camera
    res = sort(ind, team)
    assert all(where(res, r).team == "T01" for r in t1)
    assert all(where(res, r).frame_type == UNASSIGNED for r in t2)
    ex = next(e for e in res.exceptions if e.type == "TEAM_PHOTO_AFTER_GAP")
    assert "most likely T02" in ex.detail
    assert "TEAM_WITHOUT_TEAM_PHOTO" in types(res)
    res = sort(ind, team, overrides=[Override(t2[0], "team", "T02")])
    assert res.exceptions == []


def test_many_photos_flags_merged_kids():
    ind = Cam()
    ind.shot("T01")
    for i in range(1, 7):
        ind.shot(f"A{i:04d}"); ind.photos(3)
    ind.shot("A0007"); ind.photos(7)  # A0008's QR frame was missed
    res = sort(ind)
    assert types(res) == ["MANY_PHOTOS"] and res.exceptions[0].ref == "A0007"


def test_bad_file_holds_following_photos():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.photos(1)
    ind.shot(error="OSError: truncated"); held = ind.photos(1)
    res = sort(ind)
    assert types(res) == ["UNREADABLE_FILE"]
    assert where(res, held[0]).frame_type == UNASSIGNED


def test_mixed_bodies_and_no_exif():
    ind = Cam()
    ind.shot("T01", body="R5 111"); ind.shot("A0001", body="R5 222")
    ind.shot(time_source="mtime")
    res = sort(ind)
    assert types(res) == ["MIXED_BODIES", "NO_EXIF_TIME"]


def test_portrait_counts():
    ind = Cam()
    ind.shot("T01"); ind.shot("A0001"); ind.photos(3)
    res = sort(ind)
    assert len(res.subjects()["A0001"]["photos"]) == 3
    assert sum(a.frame_type == PORTRAIT for a in res.assignments) == 3
