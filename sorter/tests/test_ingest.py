import json
import os

import pytest

from photoday.ingest import ingest_card, sha256
from photoday.workspace import Event


@pytest.fixture
def event(tmp_path):
    ev = Event.open(tmp_path / "ev", create=True)
    ev.add_camera("indiv", "individuals")
    return ev


def make_card(root, files):
    for rel, data in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return root


def test_copies_twice_verified_and_read_only(tmp_path, event):
    card = make_card(tmp_path / "card", {
        "DCIM/100CANON/IMG_0001.JPG": b"one",
        "DCIM/100CANON/IMG_0001.CR3": b"raw",
        "DCIM/100CANON/.hidden": b"x",
        "MISC/AUTXFER.CTG": b"x",
    })
    r = ingest_card(event, card, "indiv", tmp_path / "backup")
    assert r.copied == 2
    primary = event.originals / "indiv/DCIM/100CANON/IMG_0001.JPG"
    second = tmp_path / "backup/ev/indiv/DCIM/100CANON/IMG_0001.JPG"
    assert primary.read_bytes() == second.read_bytes() == b"one"
    assert not os.access(primary, os.W_OK) or os.geteuid() == 0
    assert oct(primary.stat().st_mode & 0o777) == "0o444"
    assert not (event.originals / "indiv/MISC").exists()
    log = [json.loads(line) for line in event.ingest_log.read_text().splitlines()]
    assert {entry["sha256"] for entry in log} == {sha256(card / "DCIM/100CANON/IMG_0001.JPG"), sha256(card / "DCIM/100CANON/IMG_0001.CR3")}
    # the card is untouched
    assert (card / "DCIM/100CANON/IMG_0001.JPG").read_bytes() == b"one"


def test_rerun_is_idempotent_and_never_overwrites(tmp_path, event):
    card = make_card(tmp_path / "card", {"DCIM/IMG_0001.JPG": b"first"})
    ingest_card(event, card, "indiv", tmp_path / "backup")
    again = ingest_card(event, card, "indiv", tmp_path / "backup")
    assert (again.copied, again.skipped_existing) == (0, 1)

    # Second card from the same camera after the counter rolled over: same name, new photo.
    card2 = make_card(tmp_path / "card2", {"DCIM/IMG_0001.JPG": b"second"})
    r = ingest_card(event, card2, "indiv", tmp_path / "backup")
    assert (r.copied, r.renamed) == (1, 1)
    assert (event.originals / "indiv/DCIM/IMG_0001.JPG").read_bytes() == b"first"
    assert (event.originals / "indiv/DCIM/IMG_0001__1.JPG").read_bytes() == b"second"


def test_rejects_unknown_camera_and_backup_inside_workspace(tmp_path, event):
    card = make_card(tmp_path / "card", {"a.jpg": b"x"})
    with pytest.raises(ValueError):
        ingest_card(event, card, "nope", tmp_path / "backup")
    with pytest.raises(ValueError):
        ingest_card(event, card, "indiv", event.root / "backup")


def test_camera_role_cannot_change(event):
    with pytest.raises(ValueError):
        event.add_camera("indiv", "team")
    event.add_camera("indiv", "individuals", 2.5)
    assert Event.open(event.root).cameras["indiv"].clock_offset_seconds == 2.5
