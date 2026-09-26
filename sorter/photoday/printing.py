"""Printable PDFs: Subject ID sticker sheets and reusable team cards.

Stickers use the common 30-up address label layout (Avery 5160 / 8160:
2-5/8" x 1", 3 columns x 10 rows on US Letter). Each label carries the QR code
and the plain-text code in large type, plus a small line for a kid's name.

Team cards print one per half-page so a card is big enough to fill the frame
from a few feet away, with blank lines for team name and jersey color.
"""

from __future__ import annotations

from pathlib import Path

import qrcode
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

# Avery 5160 geometry
_LABEL_W, _LABEL_H = 2.625 * inch, 1.0 * inch
_COLS, _ROWS = 3, 10
_LEFT, _TOP = 0.1875 * inch, 0.5 * inch
_HGAP = 0.125 * inch


def _qr_image(payload: str) -> ImageReader:
    # Error correction M survives stickers that get a little scuffed or curled.
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2, box_size=10)
    qr.add_data(payload)
    qr.make(fit=True)
    return ImageReader(qr.make_image(fill_color="black", back_color="white").get_image())


def sticker_sheet(codes: list[str], out: str | Path, event_label: str = "") -> Path:
    out = Path(out)
    c = canvas.Canvas(str(out), pagesize=letter)
    page_w, page_h = letter
    per_page = _COLS * _ROWS
    for i, code in enumerate(codes):
        if i and i % per_page == 0:
            c.showPage()
        slot = i % per_page
        col, row = slot % _COLS, slot // _COLS
        x = _LEFT + col * (_LABEL_W + _HGAP)
        y = page_h - _TOP - (row + 1) * _LABEL_H
        pad = 0.06 * inch
        qr_size = _LABEL_H - 2 * pad
        c.drawImage(_qr_image(code), x + pad, y + pad, qr_size, qr_size)
        tx = x + qr_size + 2 * pad
        c.setFont("Helvetica-Bold", 22)
        c.drawString(tx, y + _LABEL_H - 0.42 * inch, code)
        c.setFont("Helvetica", 6.5)
        if event_label:
            c.drawString(tx, y + 0.34 * inch, event_label[:30])
        c.drawString(tx, y + 0.14 * inch, "Name: ____________________")
    c.save()
    return out


def team_cards(codes: list[str], out: str | Path) -> Path:
    out = Path(out)
    c = canvas.Canvas(str(out), pagesize=letter)
    page_w, page_h = letter
    half = page_h / 2
    for i, code in enumerate(codes):
        if i and i % 2 == 0:
            c.showPage()
        y0 = half if i % 2 == 0 else 0
        qr_size = 3.4 * inch
        c.drawImage(_qr_image(code), 0.6 * inch, y0 + (half - qr_size) / 2, qr_size, qr_size)
        tx = 4.4 * inch
        c.setFont("Helvetica-Bold", 72)
        c.drawString(tx, y0 + half - 1.6 * inch, code)
        c.setFont("Helvetica", 14)
        c.drawString(tx, y0 + half - 2.4 * inch, "TEAM CARD")
        c.drawString(tx, y0 + 1.5 * inch, "Team: ______________________")
        c.drawString(tx, y0 + 0.9 * inch, "Jersey: _____________________")
        if i % 2 == 0:
            c.setDash(4, 4)
            c.line(0.3 * inch, half, page_w - 0.3 * inch, half)
            c.setDash()
    c.save()
    return out


def subject_card(code: str, gallery_url: str, out: str | Path) -> Path:
    """A single walk-up card (4x6) with QR and gallery link, for kids with no order."""
    out = Path(out)
    w, h = 4 * inch, 6 * inch
    c = canvas.Canvas(str(out), pagesize=(w, h))
    c.drawImage(_qr_image(code), 0.5 * inch, 2.4 * inch, 3 * inch, 3 * inch)
    c.setFont("Helvetica-Bold", 40)
    c.drawCentredString(w / 2, 1.7 * inch, code)
    c.setFont("Helvetica", 9)
    c.drawCentredString(w / 2, 1.2 * inch, "See your photos after picture day:")
    c.drawCentredString(w / 2, 1.0 * inch, gallery_url)
    c.save()
    return out
