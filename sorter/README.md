# photoday: Phase 1 (ID system and sorter)

This is the laptop tool from Phase 1 of the Sports Photo Platform build spec. It does five things:

- issues Subject IDs that are never reused
- prints QR sticker sheets and team cards
- copies memory cards to two places and verifies the copies
- sorts every photo to a kid or a team using the QR frames
- writes an **exceptions report** that must be empty before anything goes to the lab

Originals are never modified. The sorter never guesses when a guess could be wrong. It holds the photo back and raises an exception instead.

## Install

```bash
cd sorter
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[test]'
```

This needs Python 3.10+. QR decoding uses OpenCV's own detectors, so nothing else needs to be installed. `pyzbar` is used as a third decoder if it's installed.

## Try it: replay a test shoot

```bash
photoday demo /tmp/demo               # 3 teams x 4 kids, with 5 injected problems
open /tmp/demo/event/output/exceptions.html
photoday demo /tmp/demo2 --no-problems
```

## Shoot-day workflow

```bash
# Once: issue IDs and print stickers (Avery 5160 / 8160, 30 per sheet)
photoday ids issue --count 600 --pdf stickers.pdf --label "Springfield Youth Soccer"
photoday ids issue --count 200 --owner device:TAB1     # block for an offline check-in tablet
photoday print team-cards --count 60 --out team-cards.pdf
photoday print stickers --codes A0101-A0130 --out reprint.pdf   # reprint issued IDs

# Per event: create the workspace and name each camera's role
photoday event init ~/Events/2026-10-03-springfield \
    --camera indiv1=individuals --camera team1=team
#   If a camera clock turns out to be off, correct it (seconds added to that camera's times):
photoday event init ~/Events/2026-10-03-springfield --offset team1=-4

# Ingest each card: copied twice, SHA-256 verified, then safe to format
photoday ingest ~/Events/2026-10-03-springfield --card /Volumes/EOS_DIGITAL \
    --camera indiv1 --backup /Volumes/BackupSSD

# Sort (exits 1 while any exception is open)
photoday sort ~/Events/2026-10-03-springfield --link-sorted [--roster checkin.csv]
```

The IDs registry defaults to `~/.photoday/registry.db`. Override it with `--registry` or `PHOTODAY_REGISTRY`.

### The sorting rule

Photos are read per camera in capture order: EXIF time with sub-seconds, then the file number. A **team QR** sets the current team and ends the current kid. A **subject QR** sets the current kid. Every other photo belongs to the current kid on the individuals camera, or to the current team on the team camera, until the next QR.

A QR code can hold the bare code (`A0347`, `T07`) or a URL ending in it, such as a preorder or gallery link on a parent's phone.

### Outputs (`<event>/output/`)

| File | Contents |
| --- | --- |
| `manifest.csv` | every photo: camera, time, frame type, team, subject |
| `subjects.csv` / `teams.csv` | per kid / per team counts |
| `exceptions.csv` / `exceptions.html` | open problems, with thumbnails and the exact fix |
| `sorted/<Txx>/<ID>/`, `sorted/<Txx>/_team/` | hard links to the sorted photos (`--link-sorted`) |

### Fixing exceptions: `overrides.csv`

To fix an exception, add a line to `<event>/overrides.csv` and run `sort` again. Re-running is fast because scan results are cached.

```csv
target,action,value,note
originals/indiv1/DCIM/100CANON/IMG_0412.JPG,qr,A0347,read the code printed under the smudged QR
originals/indiv1/DCIM/100CANON/IMG_0388.JPG,ignore,,test shot
originals/indiv1/DCIM/100CANON/IMG_0390.JPG,subject,A0346,
originals/team1/DCIM/100CANON/IMG_0120.JPG,team,T09,acts like a team card just before this frame
NO_PHOTOS:A0351,accept,,kid went home
```

| Action | Effect |
| --- | --- |
| `qr` | Treat this frame as a QR frame with that code. Everything after it flows correctly. |
| `subject` | Assign this one photo to a kid. |
| `team` | Act as if that team card was shot just before this frame. Works on either camera. |
| `ignore` | Leave the photo out of sorting. |
| `accept` | Close an exception by its `exception_id`, as shown in the report. |

### What gets flagged

| Exception | Meaning |
| --- | --- |
| `QR_UNREADABLE` | A QR was detected but couldn't be read. The photos after it are held, never given to the previous kid. It's detected even when the data area is smudged, by finding the three corner patterns. |
| `PHOTOS_WITHOUT_ID` | Photos with no kid QR before them. |
| `NO_PHOTOS` | A kid was scanned but has no photos. |
| `MANY_PHOTOS` | A kid has roughly twice the usual photo count. That's the signature of a missed QR frame that merged two kids. |
| `NOT_PHOTOGRAPHED` | On the roster but never scanned on camera. |
| `TEAM_MISMATCH` | The kid was shot under a different team than the roster says. |
| `SUBJECT_IN_TWO_TEAMS` | The same kid appears under two teams. |
| `SUBJECT_WITHOUT_TEAM` | A kid was shot before any team card. |
| `UNKNOWN_ID` | A Subject ID the registry never issued. |
| `MULTIPLE_IDS` | More than one kid QR in one frame. |
| `FOREIGN_QR` | A QR that isn't one of ours. Background codes can be silenced with `ignore_qr_payloads` in `event.json`. |
| `TEAM_PHOTO_WITHOUT_TEAM` | Team photos with no team card before them. The likely team is suggested from the synced clocks. |
| `TEAM_PHOTO_AFTER_GAP` | A long gap inside one team's run on the team camera, which means another team's card was probably missed. The photos are held and the likely team is suggested. The threshold is `team_photo_gap_minutes` in `event.json` (default 3). |
| `TEAM_WITHOUT_TEAM_PHOTO` | A team has individuals but no team photo. |
| `TEAM_WITHOUT_INDIVIDUALS` | A team has a team photo but no individuals. |
| `CLOCK_CHECK` | The team camera's time for a team is far from that team's individuals time. |
| `NO_EXIF_TIME`, `MIXED_BODIES`, `UNREADABLE_FILE`, `UNSUPPORTED_FILE` | File and card problems. |

RAW files that have a JPEG pair are copied and backed up, and they follow their JPEG. Only JPEGs are scanned.

## Tests

```bash
pytest
```

`tests/test_end_to_end.py` is the Phase 1 acceptance test, replayed on synthetic JPEGs with real QR codes:

- a clean shoot sorts 100% of frames correctly
- every injected problem appears in the exceptions report
- no photo lands on the wrong kid or team, even before fixes
- the overrides clear everything

## Before the first real test shoot

- Shoot a card of stickers and team cards under real field light. That includes glare, curled stickers and phone screens at an angle. Then run `sort` and review the decode rate.
- Time `sort` on a full-size day, about 5,000 frames at 24 MP. Scanning is parallel, and later runs are cached.
- Decide the camera naming for your bodies (for example `indiv1`, `indiv2`, `team1`), and keep one folder per body.
