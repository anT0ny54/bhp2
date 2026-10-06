// Tests for the /api/health handler. Sharp is imported lazily and its
// failure is reported as data, so these tests pass with or without the
// native module installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handler } from "../functions/health.js";
import { PROXY_VERSION, API_VERSION, FEATURES } from "../util/version.js";
import { CORS_HEADERS, SECURITY_HEADERS } from "../util/headers.js";

const BASE_EVENT = { httpMethod: "GET", headers: {} };

test("health reports ok with version, api level and features", async () => {
  const res = await handler({ ...BASE_EVENT });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "bandwidth-hero-proxy");
  assert.equal(body.version, PROXY_VERSION);
  assert.equal(body.api, Number(API_VERSION));
  assert.deepEqual(body.features, [...FEATURES]);
  assert.equal(typeof body.sharp.available, "boolean");
});

test("health version matches package.json and util/version.js", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.version, PROXY_VERSION, "package.json drifted from util/version.js");
});

test("health responses carry the shared CORS and security headers", async () => {
  const res = await handler({ ...BASE_EVENT });
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    assert.equal(res.headers[name], value, name);
  }
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(res.headers[name], value, name);
  }
  assert.equal(res.headers["cache-control"], "no-store");
});

test("health answers CORS preflight with 204", async () => {
  const res = await handler({ ...BASE_EVENT, httpMethod: "OPTIONS" });
  assert.equal(res.statusCode, 204);
});

test("health rejects non-GET methods with 405", async () => {
  const res = await handler({ ...BASE_EVENT, httpMethod: "POST" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "GET, OPTIONS");
});
