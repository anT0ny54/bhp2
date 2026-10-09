// Integration tests for the upstream fetch path and the full handler pipeline.
//
// Everything runs against local `node:http` servers on 127.0.0.1, so no
// external network is involved. The production code path is used unchanged:
// real URL/IP validation, real DNS-step deadline handling, real pinned
// sockets, real redirect processing and real Sharp encodes.
//
// How requests reach a loopback server despite the SSRF filter:
//   * Test hostnames such as `img.test` are used in URLs, so the literal-host
//     check passes.
//   * The DNS stub (setDnsLookupForTests) answers with a documentation-free
//     public address, so the real validation runs and accepts the host.
//   * `loopbackResolver` then swaps the validated address for 127.0.0.1. The
//     hostnames do not exist in real DNS, so a connection can only succeed if
//     the socket really is pinned to the validated address list (a second,
//     unpinned lookup would fail with ENOTFOUND).
// Redirects to literal private addresses are rejected by the real validator.
//
// HTTPS is not covered here: it would need a trusted test certificate. The
// pinning mechanism (`lookup` option) is identical for http and https.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import sharp from "sharp";

import {
  handler,
  configureForTests,
  resetConfigForTests,
} from "../functions/index.js";
import {
  resolveAndValidateRemoteUrl,
  setDnsLookupForTests,
  resetDnsLookupForTests,
} from "../util/validate.js";

const PUBLIC_IP = "93.184.216.34";

// --- harness -----------------------------------------------------------------

async function loopbackResolver(url, options) {
  const result = await resolveAndValidateRemoteUrl(url, options);
  if (!result.valid) return result;
  return { ...result, addresses: [{ address: "127.0.0.1", family: 4 }] };
}

let servers = [];
let dnsLog = [];

async function startServer(onRequest) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    onRequest(req, res, requests);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { port: server.address().port, requests };
}

beforeEach(() => {
  dnsLog = [];
  setDnsLookupForTests(async (hostname) => {
    dnsLog.push(hostname);
    return [{ address: PUBLIC_IP, family: 4 }];
  });
  configureForTests({ resolveRemoteUrl: loopbackResolver });
});

afterEach(async () => {
  resetConfigForTests();
  resetDnsLookupForTests();
  const closing = servers.map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  servers = [];
  await Promise.all(closing);
});

function callProxy(imageUrl, params = {}, headers = {}) {
  return handler({
    httpMethod: "GET",
    queryStringParameters: { url: imageUrl, ...params },
    headers,
  });
}

const bodyOf = (res) => Buffer.from(res.body, "base64");

function sendImage(res, buffer, headers = {}) {
  res.writeHead(200, { "content-length": buffer.length, ...headers });
  res.end(buffer);
}

// --- fixtures ------------------------------------------------------------------

// Photo-like image: smooth gradients plus mild noise, so a lossy re-encode is
// much smaller than the lossless PNG source.
async function photoPng(width = 800, height = 600) {
  const raw = Buffer.alloc(width * height * 3);
  let i = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const noise = crypto.randomInt(0, 17) - 8;
      raw[i++] = Math.max(0, Math.min(255, (x * 255) / width + noise));
      raw[i++] = Math.max(0, Math.min(255, (y * 255) / height + noise));
      raw[i++] = Math.max(0, Math.min(255, 128 + noise));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function redPng(width = 400, height = 300) {
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 20, b: 20 } } })
    .png()
    .toBuffer();
}

async function animatedGif(frames = 4, width = 120, height = 90) {
  const raw = Buffer.alloc(width * height * 3 * frames);
  for (let f = 0; f < frames; f += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = ((f * height + y) * width + x) * 3;
        raw[o] = (x * 2 + f * 40) % 256;
        raw[o + 1] = y * 2;
        raw[o + 2] = f * 60;
      }
    }
  }
  return sharp(raw, { raw: { width, height: height * frames, channels: 3, pageHeight: height } })
    .gif({ delay: Array(frames).fill(100), loop: 0 })
    .toBuffer();
}

// A WebP that is already as small as it can get: re-encoding it at quality=100
// makes it bigger, which triggers the "never return a larger file" fallback.
async function overOptimizedWebp() {
  return sharp(await photoPng(300, 200)).webp({ quality: 1, effort: 6 }).toBuffer();
}

// --- full pipeline ---------------------------------------------------------------

test("returns WebP by default with consistent telemetry and public cache headers", async () => {
  const source = await photoPng();
  const { port, requests } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));

  const res = await callProxy(`http://img.test:${port}/photo.png`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.isBase64Encoded, true);
  assert.equal(res.headers["content-type"], "image/webp");
  const body = bodyOf(res);
  assert.equal((await sharp(body).metadata()).format, "webp");
  assert.equal(res.headers["content-length"], String(body.length));
  assert.equal(res.headers["x-bh-original-size"], String(source.length));
  assert.equal(res.headers["x-bh-compressed-size"], String(body.length));
  assert.equal(res.headers["x-bh-bytes-saved"], String(source.length - body.length));
  assert.equal(res.headers["x-original-size"], String(source.length));
  assert.ok(body.length < source.length);
  assert.match(res.headers["cache-control"], /^public,/);
  assert.equal(res.headers.etag, undefined, "re-encoded output must not inherit upstream validators");
  // Virtual-host routing still works: the Host header is the URL's host.
  assert.equal(requests[0].headers.host, `img.test:${port}`);
});

test("socket is pinned to the validated address (hostname is not resolvable elsewhere)", async () => {
  const source = await photoPng(200, 150);
  const { port } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));

  const res = await callProxy(`http://does-not-exist.invalid:${port}/p.png`);

  assert.equal(res.statusCode, 200, res.body);
  // One DNS answer per hop is used for validation; the connection itself must
  // not trigger another system lookup (it would fail for a .invalid name).
  assert.deepEqual(dnsLog, ["does-not-exist.invalid"]);
});

test("jpeg=1 returns progressive JPEG", async () => {
  const source = await photoPng();
  const { port } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));

  const res = await callProxy(`http://img.test:${port}/p.png`, { jpeg: "1", quality: "50" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  const meta = await sharp(bodyOf(res)).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.isProgressive, true);
});

test("max_width resizes down and never enlarges", async () => {
  const source = await photoPng(800, 600);
  const { port } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));

  const narrow = await callProxy(`http://img.test:${port}/p.png`, { max_width: "200" });
  assert.equal((await sharp(bodyOf(narrow)).metadata()).width, 200);

  const wide = await callProxy(`http://img.test:${port}/p.png`, { max_width: "2000" });
  assert.equal((await sharp(bodyOf(wide)).metadata()).width, 800);
});

test("bw=1 produces a grayscale image", async () => {
  const source = await redPng();
  const colored = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));

  const res = await callProxy(`http://img.test:${colored.port}/red.png`, { bw: "1", quality: "90" });
  // A flat red PNG is tiny, so make sure we are looking at re-encoded output.
  const body = bodyOf(res);
  const { channels } = await sharp(body).stats();
  const [r, g, b] = channels.map((channel) => channel.mean);
  assert.ok(Math.abs(r - g) < 3 && Math.abs(g - b) < 3, `not gray: ${r}/${g}/${b}`);
});

test("animated GIF becomes an animated WebP (animation preserved)", async () => {
  const gif = await animatedGif(4);
  const { port } = await startServer((req, res) =>
    sendImage(res, gif, { "content-type": "image/gif" }));

  const res = await callProxy(`http://img.test:${port}/a.gif`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/webp");
  const meta = await sharp(bodyOf(res), { animated: true }).metadata();
  assert.equal(meta.pages, 4);
});

test("jpeg=1 on an animated GIF returns the original bytes unchanged with correct headers", async () => {
  const gif = await animatedGif(4);
  const { port } = await startServer((req, res) =>
    sendImage(res, gif, { "content-type": "image/gif", etag: '"abc123"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT", "set-cookie": "secret=1" }));

  const res = await callProxy(`http://img.test:${port}/a.gif`, { jpeg: "1" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), gif);
  assert.equal(res.headers["content-type"], "image/gif");
  assert.equal(res.headers["x-bh-original-size"], String(gif.length));
  assert.equal(res.headers["x-bh-compressed-size"], String(gif.length));
  assert.equal(res.headers["x-bh-bytes-saved"], "0");
  assert.equal(res.headers.etag, '"abc123"');
  assert.equal(res.headers["last-modified"], "Wed, 01 Jan 2025 00:00:00 GMT");
  assert.equal(res.headers["set-cookie"], undefined, "only allow-listed upstream headers are forwarded");
});

test("animated GIF without Content-Type is detected from its bytes (jpeg=1)", async () => {
  const gif = await animatedGif(3);
  const { port } = await startServer((req, res) => sendImage(res, gif)); // no content-type

  const res = await callProxy(`http://img.test:${port}/a`, { jpeg: "1" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), gif);
  assert.equal(res.headers["content-type"], "image/gif");
});

test("when re-encoding would grow the file the original is returned, with its real media type", async () => {
  const source = await overOptimizedWebp();
  const { port } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/webp", etag: '"w1"' }));

  const res = await callProxy(`http://img.test:${port}/o.webp`, { quality: "100" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), source);
  assert.equal(res.headers["content-type"], "image/webp");
  assert.equal(res.headers["x-bh-bytes-saved"], "0");
  assert.equal(res.headers["x-bh-compressed-size"], res.headers["x-bh-original-size"]);
  assert.equal(res.headers.etag, '"w1"');
});

test("never-enlarge fallback detects the format when Content-Type is missing", async () => {
  const source = await overOptimizedWebp();
  const { port } = await startServer((req, res) => sendImage(res, source));

  const res = await callProxy(`http://img.test:${port}/o`, { quality: "100" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(bodyOf(res), source);
  assert.equal(res.headers["content-type"], "image/webp");
});

test("cookie-bearing requests get private, no-store caching", async () => {
  const source = await photoPng(300, 200);
  const { port } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));

  const res = await callProxy(`http://img.test:${port}/p.png`, {}, { Cookie: "session=1" });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "private, no-store");
});

// --- upstream failures -------------------------------------------------------------

test("explicit non-image upstream responses are rejected with 415", async () => {
  const { port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html></html>");
  });
  const res = await callProxy(`http://img.test:${port}/page`);
  assert.equal(res.statusCode, 415);
  assert.equal(res.headers["cache-control"], "private, no-store");
});

test("malformed image data is reported as an error, never returned as an image", async () => {
  const { port } = await startServer((req, res) =>
    sendImage(res, Buffer.from("this is not a png at all"), { "content-type": "image/png" }));

  for (const params of [{}, { jpeg: "1" }]) {
    const res = await callProxy(`http://img.test:${port}/bad.png`, params);
    assert.ok(res.statusCode >= 400, `status ${res.statusCode}`);
    assert.notEqual(res.isBase64Encoded, true);
    assert.equal(res.headers["cache-control"], "private, no-store");
  }
});

test("truncated image data is reported as an error", async () => {
  const full = await photoPng(300, 200);
  const { port } = await startServer((req, res) =>
    sendImage(res, full.subarray(0, Math.floor(full.length / 3)), { "content-type": "image/png" }));
  const res = await callProxy(`http://img.test:${port}/cut.png`);
  assert.ok(res.statusCode >= 400, `status ${res.statusCode}`);
  assert.notEqual(res.isBase64Encoded, true);
});

test("upstream error statuses are passed through", async () => {
  const { port } = await startServer((req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  const res = await callProxy(`http://img.test:${port}/missing.png`);
  assert.equal(res.statusCode, 404);
});

test("connection failures are reported as 502 with the error code", async () => {
  const { port } = await startServer(() => {});
  // Reserve a port, then close the server so nothing is listening there.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.notEqual(deadPort, port);

  const res = await callProxy(`http://img.test:${deadPort}/x.png`);
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /Upstream connection failed \[ECONNREFUSED\]/);
});

// --- size limits ------------------------------------------------------------------

test("a declared Content-Length above the input limit is rejected with 413", async () => {
  configureForTests({ resolveRemoteUrl: loopbackResolver, maxImageBytes: 2048 });
  const { port } = await startServer((req, res) =>
    sendImage(res, Buffer.alloc(5000, 1), { "content-type": "image/png" }));
  const res = await callProxy(`http://img.test:${port}/big.png`);
  assert.equal(res.statusCode, 413);
});

test("a chunked body that grows past the input limit is cut off with 413", async () => {
  configureForTests({ resolveRemoteUrl: loopbackResolver, maxImageBytes: 2048 });
  let closedEarly = false;
  const { port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "image/png" }); // no content-length
    res.on("close", () => { closedEarly = !res.writableFinished; });
    const timer = setInterval(() => res.write(Buffer.alloc(1024, 1)), 5);
    res.on("close", () => clearInterval(timer));
  });
  const res = await callProxy(`http://img.test:${port}/stream.png`);
  assert.equal(res.statusCode, 413);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closedEarly, true, "the proxy should stop reading from the upstream");
});

test("animated passthrough above the response cap is refused with 413 instead of returned", async () => {
  // With jpeg=1 an animated image can only be returned untouched, so if the
  // untouched bytes exceed the cap the request must fail clearly.
  const gif = await animatedGif(4);
  configureForTests({ resolveRemoteUrl: loopbackResolver, maxOutputBytes: gif.length - 1 });
  const { port } = await startServer((req, res) =>
    sendImage(res, gif, { "content-type": "image/gif" }));
  const res = await callProxy(`http://img.test:${port}/a.gif`, { jpeg: "1" });
  assert.equal(res.statusCode, 413);
  assert.match(res.body, /too large to return unmodified/);
});

test("output that cannot fit the response cap at any width is refused with 413", async () => {
  const source = await photoPng(400, 300);
  configureForTests({ resolveRemoteUrl: loopbackResolver, maxOutputBytes: 10 });
  const { port } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));
  const res = await callProxy(`http://img.test:${port}/p.png`, { max_width: "100" });
  assert.equal(res.statusCode, 413);
  assert.match(res.body, /too large for the proxy response limit/);
});

test("the adaptive fallback is used by the handler when the cap is tight", async () => {
  const source = await photoPng(800, 600);
  // Measure what the normal encode would be, then cap just below it.
  const normal = await sharp(source).webp({ quality: 60, effort: 4, smartSubsample: true, minSize: true, mixed: true }).toBuffer();
  const cap = Math.floor(normal.length * 0.6);
  configureForTests({ resolveRemoteUrl: loopbackResolver, maxOutputBytes: cap });
  const { port } = await startServer((req, res) =>
    sendImage(res, source, { "content-type": "image/png" }));

  const res = await callProxy(`http://img.test:${port}/p.png`, { max_width: "300" });

  assert.equal(res.statusCode, 200, res.body);
  assert.ok(bodyOf(res).length <= cap);
});

// --- redirects --------------------------------------------------------------------

test("same-origin redirects keep Cookie and Referer; relative Location is resolved", async () => {
  const source = await photoPng(300, 200);
  const { port, requests } = await startServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final.png" });
      res.end();
    } else {
      sendImage(res, source, { "content-type": "image/png" });
    }
  });

  const res = await callProxy(`http://img.test:${port}/start`, {}, {
    Cookie: "session=1",
    Referer: "https://site.example/page",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "/final.png");
  assert.equal(requests[1].headers.cookie, "session=1");
  assert.equal(requests[1].headers.referer, "https://site.example/page");
});

test("cross-origin redirects strip Cookie and Referer but keep other headers", async () => {
  const source = await photoPng(300, 200);
  const { port, requests } = await startServer((req, res) => {
    if (req.url === "/start") {
      // Same server, different hostname: a different origin.
      res.writeHead(301, { location: `http://cdn.test:${port}/final.png` });
      res.end();
    } else {
      sendImage(res, source, { "content-type": "image/png" });
    }
  });

  const res = await callProxy(`http://img.test:${port}/start`, {}, {
    Cookie: "session=1",
    Referer: "https://site.example/page",
    "User-Agent": "TestAgent/1.0",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.cookie, "session=1");
  assert.equal(requests[1].headers.host, `cdn.test:${port}`);
  assert.equal(requests[1].headers.cookie, undefined, "cookie leaked across origins");
  assert.equal(requests[1].headers.referer, undefined, "referer leaked across origins");
  assert.equal(requests[1].headers["user-agent"], "TestAgent/1.0");
  assert.deepEqual(dnsLog, ["img.test", "cdn.test"], "every hop is re-resolved");
});

test("a redirect to a private address is rejected before any request is made", async () => {
  const { port, requests } = await startServer((req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
    res.end();
  });
  const res = await callProxy(`http://img.test:${port}/x.png`);
  assert.equal(res.statusCode, 403);
  assert.equal(requests.length, 1);
});

test("a redirect to a hostname that resolves privately is rejected", async () => {
  const { port } = await startServer((req, res) => {
    res.writeHead(302, { location: `http://rebind.test:${port}/x.png` });
    res.end();
  });
  setDnsLookupForTests(async (hostname) => (
    hostname === "rebind.test"
      ? [{ address: "10.0.0.7", family: 4 }]
      : [{ address: PUBLIC_IP, family: 4 }]
  ));
  const res = await callProxy(`http://img.test:${port}/x.png`);
  assert.equal(res.statusCode, 403);
});

test("a redirect to a documentation-range address is rejected", async () => {
  const { port } = await startServer((req, res) => {
    res.writeHead(302, { location: "http://198.51.100.9/x.png" });
    res.end();
  });
  const res = await callProxy(`http://img.test:${port}/x.png`);
  assert.equal(res.statusCode, 403);
});

test("more than 5 redirects fail with 508", async () => {
  const { port, requests } = await startServer((req, res) => {
    res.writeHead(302, { location: `/hop${requests.length}` });
    res.end();
  });
  const res = await callProxy(`http://img.test:${port}/start`);
  assert.equal(res.statusCode, 508);
  assert.equal(requests.length, 6, "initial request + 5 redirects");
});

test("an unparseable redirect Location is a 502", async () => {
  const { port } = await startServer((req, res) => {
    res.writeHead(302, { location: "http://[bad" });
    res.end();
  });
  const res = await callProxy(`http://img.test:${port}/x.png`);
  assert.equal(res.statusCode, 502);
});

// --- deadlines (Finding 2) ----------------------------------------------------------

const DEADLINE_MS = 400;
const PROMPT_MS = 1500; // generous slack for slow CI; the real DNS timeout is 2000 ms

function useShortDeadline(extra = {}) {
  configureForTests({ resolveRemoteUrl: loopbackResolver, fetchTimeoutMs: DEADLINE_MS, ...extra });
}

test("deadline: a slow upstream that never answers returns 504 promptly", async () => {
  useShortDeadline();
  const { port } = await startServer(() => { /* accept, never respond */ });

  const started = Date.now();
  const res = await callProxy(`http://img.test:${port}/hang.png`);

  assert.equal(res.statusCode, 504);
  assert.ok(Date.now() - started < PROMPT_MS, `took ${Date.now() - started} ms`);
});

test("deadline: a slow-drip body is cut off at the shared deadline", async () => {
  useShortDeadline();
  const { port } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    const timer = setInterval(() => res.write("x"), 50);
    res.on("close", () => clearInterval(timer));
  });

  const started = Date.now();
  const res = await callProxy(`http://img.test:${port}/drip.png`);

  assert.equal(res.statusCode, 504);
  assert.ok(Date.now() - started < PROMPT_MS, `took ${Date.now() - started} ms`);
});

test("deadline: DNS stalling on the first hop returns 504 well before the 2 s DNS timeout", async () => {
  useShortDeadline();
  const { port, requests } = await startServer((req, res) => res.end());
  setDnsLookupForTests(() => new Promise(() => {})); // never answers

  const started = Date.now();
  const res = await callProxy(`http://img.test:${port}/x.png`);

  assert.equal(res.statusCode, 504);
  assert.ok(Date.now() - started < PROMPT_MS, `took ${Date.now() - started} ms`);
  assert.equal(requests.length, 0);
});

test("deadline: DNS stalling at the end of a redirect chain returns 504 and starts no further request", async () => {
  useShortDeadline();
  const { port, requests } = await startServer((req, res) => {
    // Hop 1 and hop 2 answer quickly with redirects; hop 3's DNS stalls.
    if (req.url === "/a") {
      res.writeHead(302, { location: `http://hop2.test:${port}/b` });
    } else if (req.url === "/b") {
      res.writeHead(302, { location: `http://stalled.test:${port}/c` });
    }
    res.end();
  });
  setDnsLookupForTests(async (hostname) => {
    if (hostname === "stalled.test") return new Promise(() => {});
    return [{ address: PUBLIC_IP, family: 4 }];
  });

  const started = Date.now();
  const res = await callProxy(`http://hop1.test:${port}/a`);

  assert.equal(res.statusCode, 504);
  assert.ok(Date.now() - started < PROMPT_MS, `took ${Date.now() - started} ms`);
  assert.equal(requests.length, 2, "exactly the two answered hops reached the server");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(requests.length, 2, "nothing was initiated after the deadline");
});

test("deadline: a DNS answer that arrives after the deadline is never acted on", async () => {
  useShortDeadline();
  const { port, requests } = await startServer((req, res) => {
    res.writeHead(302, { location: `http://late.test:${port}/b` });
    res.end();
  });
  setDnsLookupForTests(async (hostname) => {
    if (hostname === "late.test") {
      // Answers 300 ms after the 400 ms deadline.
      await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 300));
    }
    return [{ address: PUBLIC_IP, family: 4 }];
  });

  const res = await callProxy(`http://first.test:${port}/a`);
  assert.equal(res.statusCode, 504);

  await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 500)); // let the late answer land
  assert.equal(requests.length, 1, "no request may start after the deadline");
});

test("deadline: slow hops add up against ONE shared budget", async () => {
  useShortDeadline();
  const { port, requests } = await startServer((req, res) => {
    // Every hop takes 150 ms; with a 400 ms budget the chain cannot finish.
    setTimeout(() => {
      res.writeHead(302, { location: `/hop${requests.length}` });
      res.end();
    }, 150);
  });

  const started = Date.now();
  const res = await callProxy(`http://img.test:${port}/start`);

  assert.equal(res.statusCode, 504);
  assert.ok(Date.now() - started < PROMPT_MS, `took ${Date.now() - started} ms`);
  assert.ok(requests.length <= 3, `${requests.length} hops started within a 400 ms budget`);
  const seen = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(requests.length, seen, "no hop was started after the deadline");
});
