// Shared fixtures for the Sharp-backed suites. Not a test file: the suites are
// listed explicitly in package.json, and tests/health.test.js only checks *.test.js.
import crypto from "node:crypto";
import sharp from "sharp";

// Incompressible RGB noise as a PNG: output size is predictable and always large.
export function noisePng(width, height) {
  return sharp(crypto.randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
}
