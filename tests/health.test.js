import assert from "node:assert/strict";
import { test } from "node:test";
import { handler } from "../functions/health.js";

test("health GET returns service metadata", async () => {
  const response = await handler({ httpMethod: "GET" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  const body = JSON.parse(response.body);
  assert.equal(body.status, "ok");
  assert.equal(body.api, 1);
  assert.deepEqual(body.features, ["webp", "grayscale", "maxwidth", "stats"]);
});

test("health OPTIONS returns 204", async () => {
  const response = await handler({ httpMethod: "OPTIONS" });
  assert.equal(response.statusCode, 204);
});

test("health rejects unsupported methods", async () => {
  const response = await handler({ httpMethod: "POST" });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET, OPTIONS");
});
