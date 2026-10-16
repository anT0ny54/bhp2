// End-to-end handler tests against a loopback upstream. The stubbed
// resolveRemoteUrl pins every hostname to 127.0.0.1 (the real DNS/SSRF policy
// is covered by tests/address-policy.test.js), so no external network is used.
// Different hostnames (proxy.test, other.test) give different origins on the
// same loopback server, which the redirect tests rely on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import sharp from "sharp";

import { handler, configureForTests, resetConfigForTests } from "../functions/index.js";
import { PRIVATE_HOST_ERROR, resolveAndValidateRemoteUrl } from "../util/validate.js";

let server;
let baseUrl;
let otherOriginUrl;
let port;
let routes;

// Pins every hostname to the loopback test server (see the header comment).
const loopbackResolver = async (url) => ({
  valid: true,
  url,
  addresses: [{ address: "127.0.0.1", family: 4 }],
});

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
    route(res, req);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  baseUrl = `http://proxy.test:${port}`;
  otherOriginUrl = `http://other.test:${port}`;

  configureForTests({
    fetchTimeoutMs: 2_000,
    maxOutputBytes: 4_300_000,
    resolveRemoteUrl: loopbackResolver,
  });
});

after(async () => {
  resetConfigForTests();
  server.close();
});

function event(url, extraQuery = {}, headers = {}) {
  return { httpMethod: "GET", queryStringParameters: { url, ...extraQuery }, headers };
}

function serve(path, body, contentType = "image/png") {
  routes.set(path, (res) => {
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  });
}

// Already-small JPEG of noise: re-encoding it as WebP q60 is larger.
function tinyJpeg() {
  return sharp(crypto.randomBytes(160 * 120 * 3), { raw: { width: 160, height: 120, channels: 3 } })
    .jpeg({ quality: 2 })
    .toBuffer();
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

test("a body that stalls mid-download surfaces as 504 via the socket timer", async () => {
  // Deadline far away, socket inactivity timer short: only the socket timer
  // can end this request. It used to be reported as 502 ECONNRESET.
  configureForTests({ fetchTimeoutMs: 3_000, socketTimeoutMs: 200 });
  try {
    routes.set("/drip.png", (res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(16));
    });
    const started = Date.now();
    const response = await handler(event(`${baseUrl}/drip.png`));
    assert.equal(response.statusCode, 504, response.body);
    assert.ok(Date.now() - started < 2_000, "the socket timer, not the deadline, must end it");
  } finally {
    configureForTests({ fetchTimeoutMs: 2_000, socketTimeoutMs: 5_000 });
  }
});

test("jpeg=true selects JPEG like jpeg=1; anything else stays WebP", async () => {
  serve("/flags.png", await png(64, 48));
  for (const [jpeg, type] of [["true", "image/jpeg"], ["1", "image/jpeg"], ["0", "image/webp"], [undefined, "image/webp"]]) {
    const query = jpeg === undefined ? {} : { jpeg };
    const response = await handler(event(`${baseUrl}/flags.png`, query));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["content-type"], type, `jpeg=${jpeg}`);
  }
});

test("legacy unencoded URLs keep their own query string and vary on the full query", async () => {
  let requested = "";
  routes.set("/legacy.png?w=1&h=2", (res, req) => {
    requested = req.url;
    res.writeHead(200, { "content-type": "image/png" });
    res.end(input);
  });
  const input = await png(40, 30);
  const response = await handler({
    httpMethod: "GET",
    // What Netlify delivers for ?url=http://.../legacy.png?w=1&h=2&jpeg=0&quality=50
    rawQuery: `url=${baseUrl}/legacy.png?w=1&h=2&jpeg=0&quality=50`,
    queryStringParameters: { url: `${baseUrl}/legacy.png?w=1`, h: "2", jpeg: "0", quality: "50" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(requested, "/legacy.png?w=1&h=2");
  assert.equal(response.headers["netlify-vary"], "query");
});

test("encoded URLs (Bandwidth Guardian) are decoded once from the raw query", async () => {
  serve("/enc.png?a=1&b=2", await png(40, 30));
  const imageUrl = `${baseUrl}/enc.png?a=1&b=2`;
  const response = await handler({
    httpMethod: "GET",
    rawQuery: `url=${encodeURIComponent(imageUrl)}&jpeg=0&bw=1&quality=40&max_width=768`,
    queryStringParameters: { url: imageUrl, jpeg: "0", bw: "1", quality: "40", max_width: "768" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/webp");
  assert.equal(response.headers["netlify-vary"], "query=url|quality|bw|jpeg|max_width|l");
});

test("upstream gets fixed Accept/User-Agent/Accept-Language and never the client's Cookie", async () => {
  let seen;
  routes.set("/headers.png", (res, req) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "image/png" });
    res.end(input);
  });
  const input = await png(20, 20);
  const response = await handler(event(`${baseUrl}/headers.png`, {}, {
    Accept: "image/jxl,*/*",
    "User-Agent": "Mozilla/5.0 (Linux; Android 14) Mobile ClientSpecific/1.0",
    "Accept-Language": "id-ID,id;q=0.9",
    Cookie: "session=proxy-origin-secret",
    Referer: "https://news.example/",
  }));
  assert.equal(response.statusCode, 200, response.body);
  assert.doesNotMatch(seen.accept, /jxl/);
  assert.match(seen.accept, /^image\/webp/);
  assert.equal(seen.cookie, undefined);
  assert.doesNotMatch(seen["user-agent"], /ClientSpecific/);
  assert.equal(seen["accept-language"], "en-US,en;q=0.9");
  assert.equal(seen.referer, "https://news.example/");
  // Accept, User-Agent and Accept-Language are fixed. Only Referer and DNT are
  // client-specific, and neither is part of the CDN cache key (see the
  // Caching section of docs/backend-contract.md).
  assert.match(response.headers["cache-control"], /^public,/);
});

test("Referer is kept on same-origin redirects and stripped on cross-origin ones", async () => {
  const input = await png(20, 20);
  const seen = {};
  routes.set("/hop-same.png", (res) => { res.writeHead(302, { location: "/hop-final-same.png" }); res.end(); });
  routes.set("/hop-cross.png", (res) => { res.writeHead(302, { location: `${otherOriginUrl}/hop-final-cross.png` }); res.end(); });
  for (const name of ["same", "cross"]) {
    routes.set(`/hop-final-${name}.png`, (res, req) => {
      seen[name] = req.headers.referer;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(input);
    });
  }
  const headers = { referer: "https://news.example/" };
  assert.equal((await handler(event(`${baseUrl}/hop-same.png`, {}, headers))).statusCode, 200);
  assert.equal((await handler(event(`${baseUrl}/hop-cross.png`, {}, headers))).statusCode, 200);
  assert.equal(seen.same, "https://news.example/");
  assert.equal(seen.cross, undefined);
});

test("more than 5 redirects return 508", async () => {
  for (let i = 0; i < 7; i += 1) {
    routes.set(`/loop-${i}.png`, (res) => { res.writeHead(302, { location: `/loop-${i + 1}.png` }); res.end(); });
  }
  const response = await handler(event(`${baseUrl}/loop-0.png`));
  assert.equal(response.statusCode, 508, response.body);
});

test("WebP never-enlarge returns browser-safe originals with their detected type", async () => {
  const jpeg = await tinyJpeg();
  // Wrong upstream Content-Type on purpose: the detected type must win.
  serve("/small.jpg", jpeg, "image/png");
  const response = await handler(event(`${baseUrl}/small.jpg`));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/jpeg");
  assert.equal(Buffer.from(response.body, "base64").equals(jpeg), true);
});

test("non-browser formats are always served as WebP, even when larger", async () => {
  const tiff = await sharp(crypto.randomBytes(160 * 120 * 3), { raw: { width: 160, height: 120, channels: 3 } })
    .tiff({ compression: "jpeg", quality: 2 })
    .toBuffer();
  serve("/small.tiff", tiff, "image/tiff");
  const response = await handler(event(`${baseUrl}/small.tiff`));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/webp");
});

test("source above the input size limit returns 413", async () => {
  configureForTests({ maxImageBytes: 1_000 });
  try {
    serve("/huge.png", await png(200, 200));
    const response = await handler(event(`${baseUrl}/huge.png`));
    assert.equal(response.statusCode, 413, response.body);
  } finally {
    configureForTests({ maxImageBytes: 15 * 1024 * 1024 });
  }
});

test("source above the 6 MP decode limit returns 413, not 500; exactly 6 MP is accepted", async () => {
  // Solid colour: a few KB on the wire, 7.5 MP once decoded.
  const solid = (width, height) => sharp({
    create: { width, height, channels: 3, background: "#808080" },
  }).png().toBuffer();
  serve("/too-many-pixels.png", await solid(3000, 2500));
  const over = await handler(event(`${baseUrl}/too-many-pixels.png`));
  assert.equal(over.statusCode, 413, over.body);
  assert.match(over.body, /6 MP/);
  assert.equal(over.headers["cache-control"], "private, no-store");

  serve("/at-the-limit.png", await solid(3000, 2000));
  const at = await handler(event(`${baseUrl}/at-the-limit.png`));
  assert.equal(at.statusCode, 200, at.body);
});

test("the decode limit counts every frame of an animated source", async () => {
  // Two 3.2 MP frames (6.4 MP in total). Frames differ, otherwise the encoder
  // merges them into one. Each frame alone is under the limit; the stack is not.
  const frame = (value) => Buffer.alloc(2000 * 1600 * 3, value);
  const animated = await sharp(Buffer.concat([frame(40), frame(200)]), {
    raw: { width: 2000, height: 3200, channels: 3, pageHeight: 1600 },
  }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2, "fixture must be multi-frame");
  serve("/anim-big.webp", animated, "image/webp");
  const response = await handler(event(`${baseUrl}/anim-big.webp`));
  assert.equal(response.statusCode, 413, response.body);
});

test("never-enlarge keeps WebP when bw=1 or max_width needs a smaller, grayscale image", async () => {
  const jpeg = await tinyJpeg(); // 160x120 colour, WebP re-encode is larger
  serve("/small-color.jpg", jpeg, "image/jpeg");
  const plain = await handler(event(`${baseUrl}/small-color.jpg`));
  assert.equal(plain.headers["content-type"], "image/jpeg", "control: original is returned");
  const bw = await handler(event(`${baseUrl}/small-color.jpg`, { bw: "1" }));
  assert.equal(bw.statusCode, 200, bw.body);
  assert.equal(bw.headers["content-type"], "image/webp", "bw=1 must not return the colour original");
  const narrow = await handler(event(`${baseUrl}/small-color.jpg`, { max_width: "100" }));
  assert.equal(narrow.headers["content-type"], "image/webp", "max_width below the source width must not return the original");
  assert.ok((await sharp(Buffer.from(narrow.body, "base64")).metadata()).width <= 100);
});

test("never-enlarge judges max_width by the displayed (EXIF-rotated) width", async () => {
  // Stored 120x160 with orientation 6 displays as 160x120. The stored width
  // (120) is within max_width=140, the displayed width (160) is not.
  const rotated = await sharp(crypto.randomBytes(120 * 160 * 3), { raw: { width: 120, height: 160, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 2 })
    .toBuffer();
  serve("/rotated.jpg", rotated, "image/jpeg");
  const control = await handler(event(`${baseUrl}/rotated.jpg`));
  assert.equal(control.headers["content-type"], "image/jpeg", "control: original is returned");
  const limited = await handler(event(`${baseUrl}/rotated.jpg`, { max_width: "140" }));
  assert.equal(limited.statusCode, 200, limited.body);
  assert.equal(limited.headers["content-type"], "image/webp", "the oversized original must not be returned");
  assert.ok((await sharp(Buffer.from(limited.body, "base64")).metadata()).width <= 140);
});

test("a redirect into a private or local address is rejected with 403", async () => {
  // Only the first hop (*.test) is pinned to the loopback server. Every later
  // hop goes through the REAL resolver and address policy; the targets below
  // are literals, so no DNS or network access happens.
  configureForTests({
    resolveRemoteUrl: (url, options) => new URL(url).hostname.endsWith(".test")
      ? loopbackResolver(url)
      : resolveAndValidateRemoteUrl(url, options),
  });
  try {
    const targets = [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://localhost/x.png",
      "http://127.0.0.1:1/x.png",
      "http://10.0.0.5/x.png",
    ];
    for (const [index, location] of targets.entries()) {
      routes.set(`/to-private-${index}.png`, (res) => {
        res.writeHead(302, { location });
        res.end();
      });
      const response = await handler(event(`${baseUrl}/to-private-${index}.png`));
      assert.equal(response.statusCode, 403, `${location}: ${response.body}`);
      assert.equal(response.body, PRIVATE_HOST_ERROR, location);
      assert.equal(response.headers["cache-control"], "private, no-store", location);
    }
  } finally {
    configureForTests({ resolveRemoteUrl: loopbackResolver });
  }
});

test("every x-* telemetry header is exposed to cross-origin readers", async () => {
  serve("/expose.png", await png(60, 40));
  const response = await handler(event(`${baseUrl}/expose.png`));
  assert.equal(response.statusCode, 200, response.body);
  const exposed = response.headers["access-control-expose-headers"]
    .split(",")
    .map((name) => name.trim().toLowerCase());
  const telemetry = Object.keys(response.headers).filter((name) => name.startsWith("x-") && name !== "x-frame-options" && name !== "x-content-type-options");
  assert.ok(telemetry.length >= 10, `expected the telemetry set, got ${telemetry}`);
  // Without Access-Control-Expose-Headers a cross-origin caller cannot read them.
  for (const name of telemetry) assert.ok(exposed.includes(name), `${name} is not exposed`);
  // And the list must not name headers that are never sent.
  for (const name of exposed) assert.ok(name in response.headers, `${name} is exposed but not sent`);
});
