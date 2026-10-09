// Adaptive-compression tests. These use real Sharp encodes of generated images
// but no network. The output cap is passed explicitly so the width fallback can
// be forced with small inputs instead of multi-megabyte ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import sharp from "sharp";

import { buildFallbackWidths, compressImage } from "../functions/index.js";

// Incompressible RGB noise: output size is predictable and always large, so a
// small cap reliably pushes compressImage past the quality loop.
async function noisePng(width, height) {
  return sharp(crypto.randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
}

// 1200x900 image whose detail lives at `detailWidth` px: random noise generated
// at that width and enlarged with nearest-neighbour. Downscaling to
// `detailWidth` therefore keeps all the entropy, and narrower widths lose it
// gradually (plain white noise would average to flat grey after any resize and
// produce a few dozen bytes at every width).
async function detailedPng(detailWidth) {
  const detailHeight = Math.round((detailWidth * 3) / 4);
  return sharp(crypto.randomBytes(detailWidth * detailHeight * 3), {
    raw: { width: detailWidth, height: detailHeight, channels: 3 },
  })
    .resize({ width: 1200, height: 900, kernel: "nearest", fit: "fill" })
    .png()
    .toBuffer();
}

// Mirrors encodeImage()'s WebP options at the lowest quality the quality loop
// will try, so the test can pick a cap the *requested* width cannot meet.
async function lowestQualityWebpSize(input, width) {
  const out = await sharp(input)
    .rotate()
    .resize({ width, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 10, effort: 4, smartSubsample: true, minSize: true, mixed: true })
    .toBuffer();
  return out.length;
}

// --- buildFallbackWidths -----------------------------------------------------

test("fallback widths: unrestricted requests start at 4096 and reach tiny sizes", () => {
  const widths = buildFallbackWidths(0);
  assert.equal(widths[0], 4096);
  assert.ok(widths.includes(320));
  assert.ok(widths.at(-1) < 320, "list must continue below 320");
});

test("fallback widths: max_width=800 offers 640, 320 and narrower sizes", () => {
  const widths = buildFallbackWidths(800);
  assert.equal(widths[0], 640);
  assert.ok(widths.includes(320));
  assert.ok(widths.some((w) => w < 320));
});

test("fallback widths: max_width=320 is not left empty", () => {
  const widths = buildFallbackWidths(320);
  assert.ok(widths.length > 0, "the old list was exhausted immediately here");
  assert.equal(widths[0], 240);
});

test("fallback widths: max_width=100 is not left empty", () => {
  const widths = buildFallbackWidths(100);
  assert.ok(widths.length > 0, "the old list was exhausted immediately here");
  assert.equal(widths[0], 80);
});

test("fallback widths: tiny and large limits", () => {
  assert.deepEqual(buildFallbackWidths(16), [8, 4, 2, 1]);
  assert.deepEqual(buildFallbackWidths(2), [1]);
  assert.deepEqual(buildFallbackWidths(1), []); // nothing narrower than 1 px exists
  assert.equal(buildFallbackWidths(8192)[0], 4096);
});

test("fallback widths are strictly decreasing, positive, integers and below max_width", () => {
  for (const maxWidth of [0, 1, 2, 16, 17, 100, 320, 321, 800, 4096, 4097, 8192]) {
    const widths = buildFallbackWidths(maxWidth);
    for (let i = 0; i < widths.length; i += 1) {
      assert.ok(Number.isInteger(widths[i]) && widths[i] >= 1, `${maxWidth}: ${widths[i]}`);
      if (maxWidth > 0) assert.ok(widths[i] < maxWidth, `${maxWidth}: ${widths[i]} not below limit`);
      if (i > 0) assert.ok(widths[i] < widths[i - 1], `${maxWidth}: not strictly decreasing`);
    }
  }
});

// --- compressImage regression tests -----------------------------------------

for (const maxWidth of [100, 320, 800]) {
  test(`compressImage falls back to widths below max_width=${maxWidth} when the cap is tight`, async () => {
    const input = await detailedPng(maxWidth);
    // Half of what the requested width needs even at the lowest quality, so
    // lowering quality alone cannot succeed and the width fallback must run.
    const cap = Math.floor((await lowestQualityWebpSize(input, maxWidth)) / 2);

    const output = await compressImage(input, true, false, 60, maxWidth, cap);

    assert.ok(output.length <= cap, `output ${output.length} exceeds cap ${cap}`);
    const { width, format } = await sharp(output).metadata();
    assert.equal(format, "webp");
    assert.ok(width < maxWidth, `expected width < ${maxWidth}, got ${width}`);
  });
}

test("compressImage falls back below max_width for JPEG output too", async () => {
  const input = await detailedPng(100);
  const atLimit = await sharp(input).resize({ width: 100 }).jpeg({ quality: 20, mozjpeg: true }).toBuffer();
  const cap = Math.floor(atLimit.length / 2);

  const output = await compressImage(input, false, false, 60, 100, cap);

  assert.ok(output.length <= cap);
  const { width, format } = await sharp(output).metadata();
  assert.equal(format, "jpeg");
  assert.ok(width < 100, `expected width < 100, got ${width}`);
});

test("compressImage without max_width still shrinks very large outputs", async () => {
  const input = await noisePng(1200, 900);
  const cap = Math.floor((await lowestQualityWebpSize(input, 1200)) / 8);

  const output = await compressImage(input, true, false, 60, 0, cap);

  assert.ok(output.length <= cap);
  assert.ok((await sharp(output).metadata()).width < 1200);
});

test("compressImage never enlarges a small source while falling back", async () => {
  const input = await noisePng(200, 150);
  const cap = Math.floor((await lowestQualityWebpSize(input, 200)) / 2);

  const output = await compressImage(input, true, false, 60, 0, cap);

  const { width } = await sharp(output).metadata();
  assert.ok(width <= 200, `output width ${width} is wider than the 200 px source`);
  assert.ok(output.length <= cap);
});

test("compressImage keeps the requested settings when the first encode already fits", async () => {
  const input = await noisePng(600, 400);
  const output = await compressImage(input, true, false, 60, 300, 4_300_000);
  assert.equal((await sharp(output).metadata()).width, 300);
});

test("compressImage reports 413 when no width can satisfy the cap", async () => {
  const input = await noisePng(300, 200);
  await assert.rejects(
    compressImage(input, true, false, 60, 100, 10),
    (error) => error.statusCode === 413 && /too large/i.test(error.message),
  );
});

test("compressImage rejects undecodable input without a bogus HTTP status", async () => {
  await assert.rejects(
    compressImage(Buffer.from("definitely not an image"), true, false, 60, 0, 4_300_000),
    (error) => !Number.isInteger(error.statusCode),
  );
});
