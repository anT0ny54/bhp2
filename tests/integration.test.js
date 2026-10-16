// End-to-end handler tests against a loopback upstream. The stubbed
// resolveRemoteUrl pins every request to 127.0.0.1 (the real DNS/SSRF policy
// is covered by tests/address-policy.test.js), so no external network is used.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import sharp from "sharp";

import { handler, configureForTests, resetConfigForTests } from "../functions/index.js";

let server;
let baseUrl;
let routes;

function png(width, height) {
  return sharp(crypto.randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
}

before(async () => {
  routes = new Map();
  server = http.createServer((req, res) => {
    const route = routes.get(req.url);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    route(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://proxy.test:${server.address().port}`;

  configureForTests({
    fetchTimeoutMs: 2_000,
    maxOutputBytes: 4_300_000,
    resolveRemoteUrl: async (url) => ({
      valid: true,
      url,
      addresses: [{ address: "127.0.0.1", family: 4 }],
    }),
  });
});

after(async () => {
  resetConfigForTests();
  server.close();
});

function event(url, extraQuery = {}) {
  return { httpMethod: "GET", queryStringParameters: { url, ...extraQuery } };
}

test("jpeg=1 flattens transparency onto white, not black", async () => {
  const transparent = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
  routes.set("/alpha.png", (res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(transparent);
  });

  const response = await handler(event(`${baseUrl}/alpha.png`, { jpeg: "1" }));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/jpeg");
  const { data, info } = await sharp(Buffer.from(response.body, "base64"))
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  assert.deepEqual([...data.slice(0, 3)], [255, 255, 255]);
});

test("animated sources pass through untouched on jpeg=1 regardless of Content-Type", async () => {
  // Build three distinct raw frames stacked vertically. Sharp's raw
  // pageHeight option marks the frame boundaries; passing an array of encoded
  // buffers to sharp() does not reliably create an animated output.
  const frameSize = 32 * 32 * 3;
  const frame = (r, g, b) => {
    const pixels = Buffer.alloc(frameSize);
    for (let offset = 0; offset < pixels.length; offset += 3) {
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
    }
    return pixels;
  };
  const animated = await sharp(Buffer.concat([
    frame(255, 0, 0),
    frame(0, 255, 0),
    frame(0, 0, 255),
  ]), {
    raw: { width: 32, height: 96, channels: 3, pageHeight: 32 },
  }).webp({ delay: [100, 100, 100], loop: 0 }).toBuffer();
  const meta = await sharp(animated, { animated: true }).metadata();
  assert.ok((meta.pages || 1) > 1, "fixture must be multi-frame");

  // Served with an ordinary image/png Content-Type, exactly like an APNG from
  // a CDN — the old image/(gif|webp|tiff) filter would have flattened this.
  routes.set("/anim.png", (res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(animated);
  });

  const response = await handler(event(`${baseUrl}/anim.png`, { jpeg: "1" }));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(Buffer.from(response.body, "base64").equals(animated), true);
  assert.equal(response.headers["x-bh-compressed-size"], String(animated.length));
});

test("quality=0 is honored (clamps to 1, not the default 60)", async () => {
  const input = await png(400, 300);
  routes.set("/photo.png", (res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(input);
  });

  const q0 = await handler(event(`${baseUrl}/photo.png`, { quality: "0" }));
  const q60 = await handler(event(`${baseUrl}/photo.png`));
  assert.equal(q0.statusCode, 200, q0.body);
  assert.equal(q60.statusCode, 200, q60.body);
  assert.ok(
    Number(q0.headers["x-bh-compressed-size"]) <
      Number(q60.headers["x-bh-compressed-size"]) / 2,
    `q0=${q0.headers["x-bh-compressed-size"]} q60=${q60.headers["x-bh-compressed-size"]}`,
  );
});

test("redirects to unsupported schemes return 502", async () => {
  for (const [index, location] of [
    "ftp://example.com/image.png",
    "file:///etc/passwd",
    "mailto:ops@example.com",
  ].entries()) {
    routes.set(`/bad-redirect-${index}.png`, (res) => {
      res.writeHead(302, { location });
      res.end();
    });

    const response = await handler(event(`${baseUrl}/bad-redirect-${index}.png`));
    assert.equal(response.statusCode, 502, `location=${location}: ${response.body}`);
    assert.match(response.body, /invalid redirect location/i, `location=${location}`);
  }
});

test("upstream stalls surface as 504, not 500", async () => {
  configureForTests({ fetchTimeoutMs: 300 });
  try {
    routes.set("/stall.png", () => {}); // never responds
    const response = await handler(event(`${baseUrl}/stall.png`));
    assert.equal(response.statusCode, 504);
  } finally {
    configureForTests({ fetchTimeoutMs: 2_000 });
  }
});

test("web requests return webp with telemetry headers", async () => {
  const input = await png(120, 90);
  routes.set("/plain.png", (res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(input);
  });

  const response = await handler(event(`${baseUrl}/plain.png`, { quality: "80" }));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/webp");
  assert.equal(response.headers["x-bh-original-size"], String(input.length));
  assert.ok(Number(response.headers["x-bh-bytes-saved"]) >= 0);
});
