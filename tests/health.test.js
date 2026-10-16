// Health-endpoint tests (network-free; sharp is a local dependency).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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

// package.json lists test files explicitly, so a new *.test.js that is not added
// to the scripts would silently never run in CI.
test("every test file is wired into the package.json test scripts", () => {
  const files = readdirSync(new URL("../tests/", import.meta.url))
    .filter((name) => name.endsWith(".test.js"))
    .map((name) => `tests/${name}`)
    .sort();
  const listed = (script) => new Set(packageJson.scripts[script].split(/\s+/).filter((part) => part.endsWith(".test.js")));
  const all = listed("test");
  const fast = listed("test:fast");
  const integration = listed("test:integration");
  assert.deepEqual([...all].sort(), files, '"test" must list exactly the files in tests/');
  for (const file of files) {
    assert.notEqual(fast.has(file), integration.has(file), `${file} must be in exactly one of test:fast / test:integration`);
  }
});
