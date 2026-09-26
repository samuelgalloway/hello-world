"""Per-photo scan: EXIF capture time, camera body, and QR codes in the frame.

Results are cached in the workspace keyed by file path, size and mtime (the
originals are read-only, so this is stable), so re-running the sorter after
fixing exceptions is instant.

QR decoding runs on a reduced-size decode of the JPEG first (fast; a QR frame
shot close-up easily survives 1/4 scale), then retries at larger scales only
when needed. A frame where a QR is *detected* but can't be *decoded* at any
scale is reported as unreadable rather than silently treated as a portrait.
"""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import cv2
from PIL import Image

JPEG_SUFFIXES = {".jpg", ".jpeg"}
RAW_SUFFIXES = {".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".dng", ".heic", ".heif"}

_EXIF_IFD = 0x8769
_DATETIME_ORIGINAL = 0x9003
_SUBSEC_ORIGINAL = 0x9291
_BODY_SERIAL = 0xA431
_MODEL = 0x0110


@dataclass
class ScanResult:
    rel_path: str  # relative to the event workspace
    camera: str
    capture_time: str | None  # ISO, camera clock (offset applied later)
    time_source: str  # "exif" or "mtime"
    body: str  # camera model + serial, when present
    qr_payloads: list[str] = field(default_factory=list)
    qr_unreadable: bool = False
    error: str | None = None


def read_exif(path: Path) -> tuple[datetime | None, str]:
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            sub = exif.get_ifd(_EXIF_IFD)
            body = " ".join(str(x).strip() for x in (exif.get(_MODEL), sub.get(_BODY_SERIAL)) if x)
            raw = sub.get(_DATETIME_ORIGINAL) or exif.get(0x0132)
            if not raw:
                return None, body
            dt = datetime.strptime(str(raw).strip("\x00 "), "%Y:%m:%d %H:%M:%S")
            subsec = str(sub.get(_SUBSEC_ORIGINAL) or "").strip("\x00 ")
            if subsec.isdigit():
                dt = dt.replace(microsecond=int(subsec.ljust(6, "0")[:6]))
            return dt, body
    except Exception:
        return None, ""


def _decode_img(img) -> tuple[list[str], bool]:
    """Decode with OpenCV's two QR detectors. Returns (payloads, detector_saw_something)."""
    det = cv2.QRCodeDetector()
    try:
        ok, texts, points, _ = det.detectAndDecodeMulti(img)
    except cv2.error:
        ok, texts, points = False, (), None
    found = [t for t in (texts or ()) if t]
    detected = points is not None and len(points) > 0
    if not found:
        try:
            text, pts, _ = det.detectAndDecode(img)
        except cv2.error:
            text, pts = "", None
        if text:
            found = [text]
        detected = detected or pts is not None
    if not found and hasattr(cv2, "QRCodeDetectorAruco"):
        # A second detector with a different finder search; it reads some
        # frames the classic one misses (and vice versa).
        try:
            ok, texts, points, _ = cv2.QRCodeDetectorAruco().detectAndDecodeMulti(img)
        except cv2.error:
            texts, points = (), None
        found = [t for t in (texts or ()) if t]
        detected = detected or (points is not None and len(points) > 0)
    return found, detected


def finder_patterns(img) -> int:
    """Count QR finder patterns (the three nested squares in a QR's corners).

    OpenCV's QR detector often reports nothing at all when the data area is
    damaged, which would let a smudged QR frame pass as a portrait of the
    previous kid. The finder patterns survive smudges, glare on the middle,
    and fingers over the data, so three of them of similar size mean "a QR was
    here" even when nothing decodes.
    """
    bw = cv2.adaptiveThreshold(img, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 51, 10)
    contours, hierarchy = cv2.findContours(255 - bw, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return 0
    hier = hierarchy[0]
    min_area = (img.shape[0] * img.shape[1]) * 0.00003

    def squarish(c):
        approx = cv2.approxPolyDP(c, 0.08 * cv2.arcLength(c, True), True)
        x, y, w, h = cv2.boundingRect(c)
        return len(approx) == 4 and 0.7 < w / h < 1.4, (x + w / 2, y + h / 2, w)

    # Match the *inside* of each pattern: a square white ring (5x5 modules)
    # holding a solid dark square (3x3). The outer dark ring often merges
    # with neighbouring modules or a smudge, so it isn't required.
    sizes = []
    for i, c in enumerate(contours):
        child = hier[i][2]
        if hier[i][3] < 0 or child < 0 or hier[child][2] >= 0:
            continue
        area = cv2.contourArea(c)
        inner = cv2.contourArea(contours[child])
        if area < min_area or inner <= 0 or not 1.8 < area / inner < 5.0:
            continue
        ok_outer, (cx, cy, w) = squarish(c)
        ok_inner, (ix, iy, _) = squarish(contours[child])
        if not (ok_outer and ok_inner) or abs(cx - ix) > 0.15 * w or abs(cy - iy) > 0.15 * w:
            continue
        sizes.append(area)
    # Best cluster of similar-sized patterns (within 2x of each other).
    sizes.sort()
    best = 0
    for i, s in enumerate(sizes):
        best = max(best, sum(1 for t in sizes[i:] if t <= 2 * s))
    return best


def _decode_pyzbar(path: Path) -> list[str]:
    try:
        from pyzbar import pyzbar  # optional extra decoder
    except Exception:
        return []
    img = cv2.imread(str(path), cv2.IMREAD_REDUCED_GRAYSCALE_2)
    if img is None:
        return []
    return [d.data.decode("utf-8", "replace") for d in pyzbar.decode(img) if d.type == "QRCODE"]


def decode_qr(path: Path) -> tuple[list[str], bool]:
    """Return (payloads, unreadable).

    Starts at 1/4 scale, which is fast and is enough for a QR shot close-up.
    It only moves to larger scales when something QR-like is in the frame,
    so ordinary portraits cost one small decode. "Unreadable" needs the
    corner finder patterns as evidence, because the detectors alone sometimes
    report a QR in plain portraits.
    """
    best_fp, saw = 0, False
    for flag in (cv2.IMREAD_REDUCED_GRAYSCALE_4, cv2.IMREAD_REDUCED_GRAYSCALE_2, cv2.IMREAD_GRAYSCALE):
        img = cv2.imread(str(path), flag)
        if img is None:
            raise ValueError("could not decode image")
        found, detected = _decode_img(img)
        if found:
            return sorted(set(found)), False
        saw = saw or detected
        if flag != cv2.IMREAD_GRAYSCALE:
            best_fp = max(best_fp, finder_patterns(img))
        if not (detected or best_fp >= 2):
            break  # nothing QR-like at this scale: an ordinary photo
    else:
        found = _decode_pyzbar(path)
        if found:
            return sorted(set(found)), False
    return [], best_fp >= 3 or (saw and best_fp >= 2)


def scan_file(root: str, rel_path: str, camera: str) -> ScanResult:
    path = Path(root) / rel_path
    res = ScanResult(rel_path=rel_path, camera=camera, capture_time=None, time_source="exif", body="")
    try:
        dt, res.body = read_exif(path)
        if dt is None:
            dt = datetime.fromtimestamp(path.stat().st_mtime)
            res.time_source = "mtime"
        res.capture_time = dt.isoformat()
        res.qr_payloads, res.qr_unreadable = decode_qr(path)
    except Exception as e:  # a corrupt file must not stop the whole event
        res.error = f"{type(e).__name__}: {e}"
    return res


def list_photos(event) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Return ([(camera, rel_path) of JPEGs], [(camera, rel_path) of unsupported files])."""
    photos, unsupported = [], []
    for cam in sorted(event.cameras):
        base = event.originals / cam
        if not base.exists():
            continue
        files = sorted(p for p in base.rglob("*") if p.is_file())
        jpeg_stems = {p.with_suffix("").as_posix().lower() for p in files if p.suffix.lower() in JPEG_SUFFIXES}
        for p in files:
            rel = p.relative_to(event.root).as_posix()
            suf = p.suffix.lower()
            if suf in JPEG_SUFFIXES:
                photos.append((cam, rel))
            elif suf in RAW_SUFFIXES and p.with_suffix("").as_posix().lower() in jpeg_stems:
                continue  # RAW companion of a JPEG; follows its JPEG
            elif not p.name.endswith(".partial"):
                unsupported.append((cam, rel))
    return photos, unsupported


def _cache_key(root: Path, rel: str) -> str:
    st = (root / rel).stat()
    return f"{rel}|{st.st_size}|{int(st.st_mtime)}"


def scan_event(event, workers: int | None = None, progress=None) -> list[ScanResult]:
    photos, _ = list_photos(event)
    cache: dict = {}
    if event.scan_cache.exists():
        try:
            cache = json.loads(event.scan_cache.read_text())
        except json.JSONDecodeError:
            cache = {}
    results: dict[str, ScanResult] = {}
    todo = []
    for cam, rel in photos:
        key = _cache_key(event.root, rel)
        hit = cache.get(key)
        if hit and hit.get("camera") == cam:
            results[rel] = ScanResult(**hit)
        else:
            todo.append((cam, rel, key))
    done = len(results)
    if todo:
        workers = workers or max(1, (os.cpu_count() or 2) - 1)
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futs = [(key, pool.submit(scan_file, str(event.root), rel, cam)) for cam, rel, key in todo]
            for key, fut in futs:
                r = fut.result()
                results[r.rel_path] = r
                if r.error is None:
                    cache[key] = asdict(r)
                done += 1
                if progress:
                    progress(done, len(photos))
        tmp = event.scan_cache.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        os.replace(tmp, event.scan_cache)
    return [results[rel] for _, rel in photos]


_SEQ_RE = re.compile(r"(\d+)(?!.*\d)")


def file_sequence(rel_path: str) -> int:
    """Trailing number in the filename (IMG_1234 -> 1234), used as a tie-breaker."""
    m = _SEQ_RE.search(Path(rel_path).stem)
    return int(m.group(1)) if m else -1
