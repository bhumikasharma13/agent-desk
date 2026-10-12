#!/usr/bin/env python3
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT
"""
Generate the attention-state tray icons from the base template glyphs.

Reads resources/trayTemplate.png (+ @2x), tints every non-transparent pixel
amber, paints a red dot badge in the top-right corner (with a transparent
separation ring), and writes resources/trayAttention.png (+ @2x).

Stdlib only (zlib/struct) — no Pillow/ImageMagick needed. Inputs are RGBA
(colortype 6), 8-bit, non-interlaced; the decoder assumes that layout.
Re-run whenever the base glyph changes:
    python3 resources/scripts/gen-tray-attention.py
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, ".."))

AMBER = (255, 159, 10)   # glyph tint
RED = (255, 69, 58)      # badge dot


def _read_png_rgba(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"not a PNG: {path}"
    idat = b""
    width = height = None
    i = 8
    while i < len(data):
        (length,) = struct.unpack(">I", data[i : i + 4])
        ctype = data[i + 4 : i + 8]
        body = data[i + 8 : i + 8 + length]
        if ctype == b"IHDR":
            width, height, bitdepth, colortype, _, _, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            assert bitdepth == 8 and colortype == 6 and interlace == 0, (
                f"unexpected PNG layout in {path}: "
                f"bitdepth={bitdepth} colortype={colortype} interlace={interlace}"
            )
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
        i += 12 + length
    assert width is not None and height is not None, f"no IHDR chunk in {path}"
    raw = zlib.decompress(idat)
    stride = width * 4
    # Undo per-scanline filters → flat RGBA rows.
    px = bytearray(width * height * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        for x in range(stride):
            a = line[x - 4] if x >= 4 else 0        # left
            b = prev[x]                              # up
            c = prev[x - 4] if x >= 4 else 0         # up-left
            if ftype == 0:
                val = line[x]
            elif ftype == 1:
                val = line[x] + a
            elif ftype == 2:
                val = line[x] + b
            elif ftype == 3:
                val = line[x] + ((a + b) >> 1)
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                val = line[x] + pr
            else:
                raise ValueError(f"bad filter {ftype}")
            line[x] = val & 0xFF
        px[y * stride : (y + 1) * stride] = line
        prev = line
    return width, height, px


def _write_png_rgba(path, width, height, px):
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: None
        raw.extend(px[y * stride : (y + 1) * stride])

    def chunk(tag, body):
        return (
            struct.pack(">I", len(body))
            + tag
            + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    out = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    open(path, "wb").write(out)


def _build(src, dst):
    w, h, px = _read_png_rgba(src)
    # Tint the glyph amber wherever it has any coverage.
    for idx in range(0, len(px), 4):
        if px[idx + 3] > 0:
            px[idx], px[idx + 1], px[idx + 2] = AMBER
    # Badge geometry scales with icon size.
    r = max(3, round(w * 0.20))          # dot radius
    cx, cy = w - r - 1, r + 1            # top-right center
    ring = r + max(1, round(w * 0.06))   # transparent separation radius
    for y in range(h):
        for x in range(w):
            dx, dy = x - cx, y - cy
            d2 = dx * dx + dy * dy
            i4 = (y * w + x) * 4
            if d2 <= r * r:
                px[i4], px[i4 + 1], px[i4 + 2], px[i4 + 3] = (*RED, 255)
            elif d2 <= ring * ring:
                px[i4 + 3] = 0  # clear a ring so the dot reads separately
    _write_png_rgba(dst, w, h, px)
    print(f"wrote {dst} ({w}x{h})")


if __name__ == "__main__":
    _build(os.path.join(RES, "trayTemplate.png"), os.path.join(RES, "trayAttention.png"))
    _build(os.path.join(RES, "trayTemplate@2x.png"), os.path.join(RES, "trayAttention@2x.png"))
