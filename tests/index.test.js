// Handler tests that terminate before any network I/O: missing/invalid url,
// private hosts, method handling, shared headers. Fetch-path behaviour is
// covered by tests/integration.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import { handler, buildFallbackWidths, getFallbackQuality, getImageUrl, parseInteger } from "../functions/index.js";
import { INVALID_URL_ERROR, PRIVATE_HOST_ERROR } from "../util/validate.js";
import { BASE_HEADERS } from "../util/headers.js";

test("GET without url returns the service banner", async () => {
  const response = await handler({ httpMethod: "GET", queryStringParameters: {} });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "bandwidth-hero-proxy");
});

test("POST is rejected with 405", async () => {
  const response = await handler({ httpMethod: "POST", queryStringParameters: {} });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET, OPTIONS");
});

test("OPTIONS returns 204", async () => {
  const response = await handler({ httpMethod: "OPTIONS", queryStringParameters: {} });
  assert.equal(response.statusCode, 204);
});

test("non-HTTP URLs are rejected with 400", async () => {
  for (const url of ["ftp://example.com/a.png", "example.com/a.png", "http://"]) {
    const response = await handler({ httpMethod: "GET", queryStringParameters: { url } });
    assert.equal(response.statusCode, 400, url);
    assert.equal(response.body, INVALID_URL_ERROR, url);
  }
});

test("private hosts are rejected with 403 (not 400) before any fetch", async () => {
  for (const url of [
    "http://127.0.0.1/a.png",
    "http://10.0.0.8/a.png",
    "http://192.168.1.1/a.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/a.png",
    "http://[::1]/a.png",
    "http://[::ffff:10.0.0.1]/a.png",
  ]) {
    const response = await handler({ httpMethod: "GET", queryStringParameters: { url } });
    assert.equal(response.statusCode, 403, url);
    assert.equal(response.body, PRIVATE_HOST_ERROR, url);
  }
});

test("every response carries the shared BASE_HEADERS", async () => {
  const response = await handler({ httpMethod: "GET", queryStringParameters: {} });
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    assert.equal(response.headers[name], value, `missing ${name}`);
  }
});

test("integer query parsing rejects partial numbers and clamps valid integers", () => {
  assert.equal(parseInteger("20px", 60, 1, 100), 60);
  assert.equal(parseInteger("1e2", 60, 1, 100), 60);
  assert.equal(parseInteger(" 20 ", 60, 1, 100), 20);
  assert.equal(parseInteger("0", 60, 1, 100), 1);
  assert.equal(parseInteger("-5", 60, 1, 100), 1);
  assert.equal(parseInteger("9000", 0, 0, 8192), 8192);
});

test("fallback quality never exceeds a low requested quality", () => {
  assert.equal(getFallbackQuality(1, true), 1);
  assert.equal(getFallbackQuality(9, true), 9);
  assert.equal(getFallbackQuality(5, false), 5);
  assert.equal(getFallbackQuality(19, false), 19);
  assert.equal(getFallbackQuality(60, true), 30);
  assert.equal(getFallbackQuality(60, false), 30);
});

test("buildFallbackWidths only narrows below the requested width", () => {
  const all = buildFallbackWidths(0);
  assert.equal(all.length, 16);
  assert.deepEqual(buildFallbackWidths(100), [80, 64, 48, 32, 16]);
  assert.deepEqual(buildFallbackWidths(320), [240, 160, 120, 80, 64, 48, 32, 16]);
  assert.deepEqual(buildFallbackWidths(16), [8, 4, 2, 1]);
  assert.ok(all.every((width) => width > 0));
});

test("getImageUrl decodes encoded URLs once and stops at the next parameter", () => {
  const image = "https://cdn.example/a.jpg?w=400&h=300";
  assert.deepEqual(
    getImageUrl({ rawQuery: `url=${encodeURIComponent(image)}&jpeg=0&bw=1&quality=60&extra=1` }),
    { url: image, legacy: false },
  );
  // Parameter order does not matter.
  assert.deepEqual(
    getImageUrl({ rawQuery: `jpeg=0&url=${encodeURIComponent(image)}&quality=60` }),
    { url: image, legacy: false },
  );
});

test("getImageUrl rebuilds legacy unencoded URLs up to the first proxy parameter", () => {
  assert.deepEqual(
    getImageUrl({ rawQuery: "url=http://cdn.example/a.jpg?w=400&h=300&jpeg=1&l=40" }),
    { url: "http://cdn.example/a.jpg?w=400&h=300", legacy: true },
  );
  // A legacy URL without its own "&" needs no special cache handling.
  assert.deepEqual(
    getImageUrl({ rawQuery: "url=http://cdn.example/a.jpg?w=400&bw=1" }),
    { url: "http://cdn.example/a.jpg?w=400", legacy: false },
  );
});

test("getImageUrl falls back to the parsed parameter and handles absence", () => {
  assert.deepEqual(getImageUrl({ queryStringParameters: { url: "https://a.example/x.png" } }),
    { url: "https://a.example/x.png", legacy: false });
  assert.deepEqual(getImageUrl({ rawQuery: "", queryStringParameters: {} }), { url: "", legacy: false });
  assert.deepEqual(getImageUrl({ rawQuery: "url=&jpeg=1" }), { url: "", legacy: false });
});
