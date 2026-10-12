// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Regression test for the app-icon guard. Zero-dep (node:test + node:zlib), so it runs with
// `node --test scripts/verifyIcon.test.cjs` without the workspace node_modules. Builds tiny
// PNG-in-ICNS blobs in memory — no binary fixtures to rot — and pins the guard's contract:
// transparent corners + keyline pass; opaque corners, full-bleed edges, and any non-alpha /
// undecodable format FAIL CLOSED. Also asserts the actually-shipped resources/icon.icns passes.

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const path = require("node:path");
const { assertIconValid } = require("./verifyIcon.cjs");

// --- minimal PNG / ICNS builders -------------------------------------------------------------
// The guard does not validate CRCs, so we zero them; it reads IHDR fields + IDAT only.
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

// pixels: (x,y) => [r,g,b,a] for colorType 6, or [g,a] for colorType 4.
function makePng(width, height, colorType, pixel) {
  const channels = colorType === 6 ? 4 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // bit depth
  ihdr[9] = colorType;  // 2=RGB, 4=grey+alpha, 6=RGBA
  ihdr[12] = 0;         // interlace
  const raw = Buffer.alloc(height * (1 + width * channels));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) for (const b of pixel(x, y)) raw[p++] = b;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeRgbPng(width, height, pixel) {
  // colorType 2 (RGB, no alpha channel) — its own builder since the pixel width differs.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) { raw[p++] = 0; for (let x = 0; x < width; x++) for (const b of pixel(x, y)) raw[p++] = b; }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Wrap one or more PNG reps as ICNS chunks. Accepts a single PNG or [{type,png}] pairs so a
// test can embed several representations (the guard checks every one, not just the largest).
function makeIcns(pngOrReps) {
  const reps = Buffer.isBuffer(pngOrReps)
    ? [{ type: "ic10", png: pngOrReps }]
    : pngOrReps;
  const chunks = reps.map(({ type, png }) => {
    const typeLen = Buffer.alloc(8);
    typeLen.write(type, 0, "ascii");
    typeLen.writeUInt32BE(8 + png.length, 4); // chunk length includes its 8-byte header
    return Buffer.concat([typeLen, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

// The guard reads from a path, so round-trip our in-memory blob through a temp file.
const fs = require("node:fs");
const os = require("node:os");
function withIcns(png, fn) {
  const f = path.join(os.tmpdir(), `guard-test-${process.pid}-${Math.round(process.hrtime()[1])}.icns`);
  fs.writeFileSync(f, makeIcns(png));
  try { return fn(f); } finally { fs.rmSync(f, { force: true }); }
}

const CLEAR = () => [0, 0, 0, 0]; // fully transparent RGBA

// --- tests ------------------------------------------------------------------------------------
test("passes a transparent-cornered RGBA icon", () => {
  const png = makePng(16, 16, 6, CLEAR);
  withIcns(png, (f) => assert.doesNotThrow(() => assertIconValid(f)));
});

test("fails an opaque-cornered icon (white-border regression)", () => {
  const png = makePng(16, 16, 6, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  withIcns(png, (f) => assert.throws(() => assertIconValid(f), /corner is opaque/));
});

test("fails a full-bleed icon (opaque edge, no keyline)", () => {
  // Corners clear, but the top-edge midpoint opaque → keyline-margin violation.
  const png = makePng(16, 16, 6, (x, y) => (y === 0 && x === 8 ? [10, 10, 10, 255] : [0, 0, 0, 0]));
  withIcns(png, (f) => assert.throws(() => assertIconValid(f), /keyline margin/));
});

test("fails when a NON-largest rep is opaque even if the largest is clean", () => {
  // A manual export can leave the 1024 rep transparent but break a smaller size — that still
  // paints a white border in the menu bar / Finder list. The guard must check every rep.
  const clean = makePng(32, 32, 6, CLEAR);
  const opaqueCorner = makePng(16, 16, 6, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  const icns = makeIcns([{ type: "ic11", png: opaqueCorner }, { type: "icp5", png: clean }]);
  const f = path.join(os.tmpdir(), `guard-multirep-${process.pid}.icns`);
  fs.writeFileSync(f, icns);
  try { assert.throws(() => assertIconValid(f), /corner is opaque/); } finally { fs.rmSync(f, { force: true }); }
});

test("fails closed on an alpha-less (RGB) icon instead of reading a colour byte as alpha", () => {
  const png = makeRgbPng(16, 16, () => [0, 0, 0]); // opaque black everywhere, no alpha channel
  withIcns(png, (f) => assert.throws(() => assertIconValid(f), /could not be verified/));
});

test("fails closed when the .icns has no PNG representation", () => {
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8, 4);
  const f = path.join(os.tmpdir(), `guard-empty-${process.pid}.icns`);
  fs.writeFileSync(f, header);
  try { assert.throws(() => assertIconValid(f), /no PNG representation/); } finally { fs.rmSync(f, { force: true }); }
});

test("the shipped resources/icon.icns is valid", () => {
  assert.doesNotThrow(() => assertIconValid(path.resolve(__dirname, "../resources/icon.icns")));
});
