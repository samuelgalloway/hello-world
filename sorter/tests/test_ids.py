import pytest

from photoday.ids import Registry, parse_payload, team_codes


@pytest.mark.parametrize("payload,kind,code", [
    ("A0347", "subject", "A0347"),
    (" a0347 ", "subject", "A0347"),
    ("T01", "team", "T01"),
    ("T60", "team", "T60"),
    ("T61", "foreign", "T61"),
    ("T00", "foreign", "T00"),
    ("T0347", "foreign", "T0347"),  # T is never a subject prefix
    ("I0001", "foreign", "I0001"),  # I/O skipped (look like 1/0)
    ("https://photos.example.com/g/B0012", "subject", "B0012"),
    ("https://photos.example.com/g?id=B0012", "subject", "B0012"),
    ("https://sponsor.example.com/", "foreign", "https://sponsor.example.com/"),
    ("hello", "foreign", "hello"),
])
def test_parse_payload(payload, kind, code):
    p = parse_payload(payload)
    assert (p.kind, p.code) == (kind, code)


def test_team_codes():
    assert team_codes(3) == ["T01", "T02", "T03"]
    assert len(team_codes()) == 60
    with pytest.raises(ValueError):
        team_codes(61)


def test_registry_never_reuses(tmp_path):
    db = tmp_path / "reg.db"
    with Registry(db) as reg:
        a = reg.issue(5)
        b = reg.issue(5, owner="device:TAB1")
    assert a == ["A0001", "A0002", "A0003", "A0004", "A0005"]
    assert b[0] == "A0006"
    with Registry(db) as reg:  # survives reopening
        c = reg.issue(2, prefix="B")
        assert c == ["B0001", "B0002"]
        assert reg.is_issued("A0003") and not reg.is_issued("A0011")
        owners = [row[1] for row in reg.batches()]
        assert owners == ["stickers", "device:TAB1", "stickers"]
    assert not set(a) & set(b)


def test_registry_rejects_bad_prefix(tmp_path):
    with Registry(tmp_path / "r.db") as reg:
        with pytest.raises(ValueError):
            reg.issue(1, prefix="T")
