// Health-endpoint tests (network-free; sharp is a local dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handler } from "../functions/health.js";
import { PROXY_VERSION, API_VERSION, FEATURES } from "../util/version.js";
import { BASE_HEADERS } from "../util/headers.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const backendContract = readFileSync(new URL("../docs/backend-contract.md", import.meta.url), "utf8");

test("release version and feature metadata stay in sync", () => {
  const contractLines = backendContract.split(/\r?\n/).map((line) => line.trim());
  assert.equal(packageJson.version, PROXY_VERSION);
  assert.ok(contractLines.includes(`| ${PROXY_VERSION} | ${API_VERSION} | Stable |`));
  assert.ok(backendContract.includes(`X-BH-Features: ${FEATURES.join(",")}`));
});

test("GET returns ok with version, api level and features", async () => {
  const response = await handler({ httpMethod: "GET" });
  assert.equal(response.statusCode, 200);
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    assert.equal(response.headers[name], value, `missing header ${name}`);
  }
  assert.match(response.headers["content-type"], /application\/json/);
  const body = JSON.parse(response.body);
  assert.equal(body.status, "ok");
  assert.equal(body.version, PROXY_VERSION);
  assert.equal(body.api, Number(API_VERSION)); // version and API level are distinct
  assert.deepEqual(body.features, [...FEATURES]);
  assert.equal(typeof body.sharp.available, "boolean");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("non-GET methods are rejected with 405", async () => {
  const response = await handler({ httpMethod: "POST" });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET, OPTIONS");
  assert.match(response.headers["content-type"], /text\/plain/);
});

test("OPTIONS is answered with 204", async () => {
  const response = await handler({ httpMethod: "OPTIONS" });
  assert.equal(response.statusCode, 204);
});
