// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Build-time guard for the macOS app icon (resources/icon.icns) — see resources/scripts/gen-icon.py
// for the canonical explanation of the two invariants and why macOS depends on them.
//
// This decodes the largest PNG representation straight off the shipped .icns and asserts:
//   1. transparent corners  — else macOS (which paints app icons unmasked) draws a white border;
//   2. keyline margin        — edge midpoints transparent, else the art is full-bleed / oversized.
//
// Fail-CLOSED: the icon is always produced by gen-icon.py (8-bit RGBA via iconutil), so anything
// this cannot verify — no PNG rep, a format it can't decode, a colour type with no alpha channel,
// truncated pixel data — is itself the regression signal and throws. "Could not verify" is never
// treated as "clean"; that is the only way a self-asserting bypass can't slip a bad icon through.
// Dependency-free: Node built-in fs + zlib only.

const fs = require("node:fs");
const zlib = require("node:zlib");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIM = 4096; // no icns representation is larger; a bigger IHDR is malformed
// Bounds the largest decodable row-stream: MAX_DIM rows of (MAX_DIM*4 RGBA + 1 filter) bytes,
// plus slack. Sized off MAX_DIM so it can never reject a dimension the decoder still admits.
const MAX_INFLATE = MAX_DIM * (MAX_DIM * 4 + 1) + 64;
// A regression paints an opaque border/edge (alpha ~255); a legitimately transparent corner is 0
// at every size, but downscaling the master to the small reps (16/32px) leaves sub-visible
// antialiasing (alpha ~1) at the keyline edge. Allow that noise; anything above it is a real
// opaque pixel. 8 sits ~30x below a true border, so it cannot mask the white-border bug.
const AA_TOLERANCE = 8;

// Return EVERY embedded PNG representation from the ICNS TLV container, not just the largest:
// iconutil stores each icon size as its own PNG, so a regression confined to a smaller rep (the
// 32px menu-bar / Finder-list icon) must be caught too. Non-PNG chunks (the 'TOC ' index,
// metadata, legacy ARGB reps) are skipped — they carry no PNG to decode, not a failure.
function collectPngsFromIcns(buf) {
  const reps = [];
  let off = 8; // skip 'icns' magic + 4-byte total length
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4); // chunk length includes its own 8-byte header
    if (len < 8 || off + len > buf.length) break;
    const data = buf.subarray(off + 8, off + len);
    if (data.length >= 24 && data.subarray(0, 8).equals(PNG_SIG)) {
      reps.push({ width: data.readUInt32BE(16), png: data }); // IHDR width at PNG offset 16
    }
    off += len;
  }
  return reps;
}

// Minimal non-interlaced 8-bit PNG decoder → {width,height,channels,pixels}. Throws (never
// returns a partial/guessed result) on any structure it cannot faithfully reconstruct.
function decodePng(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  // Only the alpha-bearing truecolour/grayscale forms gen-icon.py emits are verifiable. Palette
  // (3) and the alpha-less types (0 grayscale, 2 RGB) carry no alpha to check — an icon exported
  // without alpha is the white-border bug itself, so reject rather than read a colour byte as alpha.
  const channels = { 4: 2, 6: 4 }[colorType];
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) {
    throw new Error(`unverifiable PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}); expected 8-bit RGBA/grey+alpha, non-interlaced`);
  }
  if (width <= 0 || height <= 0 || width > MAX_DIM || height > MAX_DIM) {
    throw new Error(`implausible PNG dimensions ${width}x${height}`);
  }

  const idat = [];
  let off = 8;
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off);
    if (off + 12 + len > png.length) throw new Error("malformed PNG chunk length");
    const type = png.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len; // length + type + data + CRC
    if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_INFLATE });

  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("truncated PNG pixel data");
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = cur; break;
        case 1: val = cur + a; break;
        case 2: val = cur + b; break;
        case 3: val = cur + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter type ${filter}`);
      }
      out[y * stride + x] = val & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

// Alpha is always the last channel of the pixel (channels ∈ {2 grey+alpha, 4 RGBA}).
function alphaAt(img, x, y) {
  return img.pixels[(y * img.width + x) * img.channels + (img.channels - 1)];
}

const REGEN = "regenerate with resources/scripts/gen-icon.py, never a manual export.";

// Validate a single decoded representation: transparent corners + transparent edge midpoints.
function assertRepValid(icnsPath, img) {
  const { width: w, height: h } = img;
  const tag = `${w}x${h} rep`;
  const corners = {
    "top-left": [0, 0], "top-right": [w - 1, 0],
    "bottom-left": [0, h - 1], "bottom-right": [w - 1, h - 1],
  };
  for (const [name, [x, y]] of Object.entries(corners)) {
    if (alphaAt(img, x, y) > AA_TOLERANCE) {
      throw new Error(
        `[icon-guard] FATAL: ${icnsPath} (${tag}) ${name} corner is opaque (alpha=${alphaAt(img, x, y)}). ` +
        `The icon lost its transparency — ${REGEN}`,
      );
    }
  }
  const edges = { "top-edge": [w >> 1, 0], "left-edge": [0, h >> 1] };
  for (const [name, [x, y]] of Object.entries(edges)) {
    if (alphaAt(img, x, y) > AA_TOLERANCE) {
      throw new Error(
        `[icon-guard] FATAL: ${icnsPath} (${tag}) ${name} is opaque (alpha=${alphaAt(img, x, y)}). ` +
        `The art is full-bleed with no keyline margin and will render oversized in the dock — ${REGEN}`,
      );
    }
  }
}

// Throws Error on a confirmed regression OR on anything it cannot verify; resolves silently only
// when EVERY PNG representation in the shipped icon is decodable AND holds both invariants. The
// path validated is the repo source, which packagerConfig.icon + extraResource copy verbatim into
// the .app — so validating it here validates exactly what ships.
function assertIconValid(icnsPath) {
  const buf = fs.readFileSync(icnsPath);
  const reps = collectPngsFromIcns(buf);
  if (reps.length === 0) {
    throw new Error(
      `[icon-guard] FATAL: no PNG representation found in ${icnsPath}; cannot verify the app icon. ${REGEN}`,
    );
  }
  for (const rep of reps) {
    let img;
    try {
      img = decodePng(rep.png);
    } catch (err) {
      throw new Error(
        `[icon-guard] FATAL: ${icnsPath} (${rep.width}px rep) could not be verified (${err.message}). ${REGEN}`,
      );
    }
    assertRepValid(icnsPath, img);
  }
}

module.exports = { assertIconValid };

// CLI: node scripts/verifyIcon.cjs <path-to-icns>
if (require.main === module) {
  const p = process.argv[2];
  if (!p) { console.error("usage: node scripts/verifyIcon.cjs <icon.icns>"); process.exit(2); }
  try {
    assertIconValid(p);
    console.log(`[icon-guard] OK: ${p} — transparent corners + keyline margin.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
