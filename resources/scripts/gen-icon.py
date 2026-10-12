#!/usr/bin/env python3
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT
"""Regenerate resources/icon.icns from resources/icon.svg — the single source of truth.

Why this script exists: the .icns is a binary that cannot be reviewed in a diff, and a
hand-export through Preview / a non-alpha-aware converter silently flattens the rounded-corner
transparency onto a white matte. Regenerating only through this script keeps two invariants
that macOS depends on (scripts/verifyIcon.cjs re-asserts them off the shipped binary at build):

  1. Transparent corners — macOS does not mask app icons (unlike iOS); it paints the PNG as-is,
     so the rounded-rect corners MUST be alpha 0 or they render as a hard white square.
  2. The Apple keyline — the art sits in an 824/1024 (~80.5%) box centered on a transparent
     1024 canvas (100px margin each side). Full-bleed art renders visibly larger than every
     other dock icon; the keyline is what makes it align with native apps.

Requirements (macOS): rsvg-convert (`brew install librsvg`), Pillow (`pip install Pillow`),
iconutil (ships with Xcode CLT). Run from anywhere:  python3 resources/scripts/gen-icon.py
The script self-verifies both invariants at the end and exits non-zero if either is violated.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

CANVAS = 1024          # master canvas edge (== 512@2x, the largest icns representation)
KEYLINE = 824          # Apple macOS icon grid: art box on a 1024 canvas (~80.5%)
MARGIN = (CANVAS - KEYLINE) // 2  # 100px transparent margin on each side
RENDER = 2048          # oversample the SVG, then downscale — keeps the art crisp

# Standard macOS iconset representations: (filename, pixel size).
ICONSET = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

RES = Path(__file__).resolve().parent.parent  # .../resources
SVG = RES / "icon.svg"
ICNS = RES / "icon.icns"


def render_svg(dst: Path) -> None:
    """Rasterize the SVG to a square RGBA PNG at RENDER px with rsvg-convert (alpha-correct)."""
    subprocess.run(
        ["rsvg-convert", "-w", str(RENDER), "-h", str(RENDER), "-o", str(dst), str(SVG)],
        check=True,
    )


def build_master(art_png: Path) -> Image.Image:
    """Scale the rendered art into the keyline box, centered on a transparent 1024 canvas."""
    art = Image.open(art_png).convert("RGBA").resize((KEYLINE, KEYLINE), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(art, (MARGIN, MARGIN), art)  # third arg = alpha mask, preserves transparency
    return canvas


def verify(master: Image.Image) -> None:
    """Fail loudly if the two invariants are broken, so a bad icon never reaches iconutil."""
    px = master.load()
    w, h = master.size
    # Corners must be transparent (guards the white-matte regression).
    for name, (x, y) in {
        "top-left": (0, 0),
        "top-right": (w - 1, 0),
        "bottom-left": (0, h - 1),
        "bottom-right": (w - 1, h - 1),
    }.items():
        if px[x, y][3] != 0:
            sys.exit(f"[gen-icon] FATAL: {name} corner is not transparent (alpha={px[x, y][3]}).")
    # Edge midpoints must be transparent too (guards full-bleed art with no keyline margin).
    for name, (x, y) in {
        "top-edge": (w // 2, 0),
        "left-edge": (0, h // 2),
    }.items():
        if px[x, y][3] != 0:
            sys.exit(f"[gen-icon] FATAL: {name} is opaque — art has no keyline margin (alpha={px[x, y][3]}).")


def main() -> None:
    if not SVG.exists():
        sys.exit(f"[gen-icon] FATAL: source SVG not found at {SVG}")
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        art = tmpd / "art.png"
        render_svg(art)
        master = build_master(art)
        verify(master)

        iconset = tmpd / "icon.iconset"
        iconset.mkdir()
        for name, size in ICONSET:
            master.resize((size, size), Image.LANCZOS).save(iconset / name)

        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ICNS)], check=True)
    print(f"[gen-icon] wrote {ICNS} — corners transparent, art in {KEYLINE}/{CANVAS} keyline.")


if __name__ == "__main__":
    main()
