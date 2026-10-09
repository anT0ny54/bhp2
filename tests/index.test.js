// Compatibility and security tests for the proxy handler and URL validation.
// These tests never touch the network: every case below fails (or succeeds)
// before any upstream fetch would be attempted. The upstream fetch path
// (redirects, pinning, deadlines, encoding) is covered by tests/integration.test.js
// and tests/compress.test.js. Address-range boundaries: tests/address-policy.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import { handler } from "../functions/index.js";
import {
  INVALID_URL_ERROR,
  PRIVATE_HOST_ERROR,
  parseHttpUrl,
  isPrivateIp,
  isPrivateHost,
  createPinnedLookup,
  resolveAndValidateRemoteUrl,
  setDnsLookupForTests,
  resetDnsLookupForTests,
  DNS_RESOLUTION_ERROR,
} from "../util/validate.js";

const BASE_EVENT = {
  httpMethod: "GET",
  queryStringParameters: {},
  headers: {},
};

test("handler returns the legacy handshake for requests without a url", async () => {
  const res = await handler({ ...BASE_EVENT });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "bandwidth-hero-proxy");
  assert.match(res.headers["content-type"], /text\/plain/);
});

test("handler answers CORS preflight with 204", async () => {
  const res = await handler({ ...BASE_EVENT, httpMethod: "OPTIONS" });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("handler rejects non-GET methods with 405", async () => {
  const res = await handler({ ...BASE_EVENT, httpMethod: "POST" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "GET, OPTIONS");
});

test("handler rejects non-HTTP(S) urls", async () => {
  const res = await handler({
    ...BASE_EVENT,
    queryStringParameters: { url: "ftp://example.com/image.png" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, INVALID_URL_ERROR);
});

test("handler rejects syntactically invalid urls", async () => {
  const res = await handler({
    ...BASE_EVENT,
    queryStringParameters: { url: "not a url at all" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, INVALID_URL_ERROR);
});

test("handler rejects literal private hosts before any fetch", async () => {
  for (const url of [
    "http://127.0.0.1/x.png",
    "http://localhost/x.png",
    "http://192.168.1.1/x.png",
    "http://10.0.0.5/x.png",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/x.png",
    "http://192.0.0.9/x.png", // IETF reserved range
    "http://192.0.2.1/x.png", // TEST-NET-1
    "http://198.51.100.1/x.png", // TEST-NET-2
    "http://203.0.113.1/x.png", // TEST-NET-3
    "http://[2001:db8::1]/x.png", // IPv6 documentation
    "http://[::ffff:192.0.2.1]/x.png", // IPv4-mapped documentation address
    "http://[::1]/x.png",
    "http://[fd00::1]/x.png",
    "http://[fe80::1]/x.png",
  ]) {
    const res = await handler({ ...BASE_EVENT, queryStringParameters: { url } });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.body, PRIVATE_HOST_ERROR, url);
  }
});

test("parseHttpUrl accepts http/https and rejects everything else", () => {
  assert.equal(parseHttpUrl("http://example.com/a.png").protocol, "http:");
  assert.equal(parseHttpUrl("https://example.com/a.png").protocol, "https:");
  assert.equal(parseHttpUrl("ftp://example.com/a.png"), null);
  assert.equal(parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpUrl("http://"), null);
  assert.equal(parseHttpUrl("http://exa mple.com/x.png"), null);
  assert.equal(parseHttpUrl("::nonsense::"), null);
});

test("isPrivateIp blocks loopback, RFC1918, link-local, CGNAT, multicast and reserved ranges", () => {
  for (const ip of [
    "0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "169.254.1.1", "100.64.0.0", "100.127.255.255",
    "198.18.0.1", "198.19.255.255", "192.0.0.9", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fd12:3456::1", "fe80::1", "ff02::1",
    // IPv4-compatible / mapped / NAT64 / 6to4 forms judged by embedded IPv4.
    "::127.0.0.1", "::a9fe:a9fe", "::10.0.0.1", "::ffff:127.0.0.1",
    "64:ff9b::7f00:1", "2002:7f00:1::1",
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("isPrivateHost blocks localhost aliases and bracketed IPs", () => {
  for (const host of ["localhost", "LOCALHOST", "localhost.", "[::1]", "ip6-loopback"]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  assert.equal(isPrivateHost("example.com"), false);
});

test("createPinnedLookup returns the validated records and honors family selection", () => {
  const records = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];
  const lookup = createPinnedLookup(records);

  lookup("example.com", { all: true }, (err, all) => {
    assert.equal(err, null);
    assert.deepEqual(all, records);
  });

  lookup("example.com", { family: 6 }, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, records[1].address);
    assert.equal(family, 6);
  });

  // No family preference: falls back to the first validated record.
  lookup("example.com", {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, records[0].address);
    assert.equal(family, 4);
  });
});

test("resolveAndValidateRemoteUrl strips IPv6 brackets before the DNS lookup", async () => {
  let seen;
  setDnsLookupForTests(async (hostname) => {
    seen = hostname;
    return [{ address: "2606:4700:4700::1111", family: 6 }];
  });
  try {
    const result = await resolveAndValidateRemoteUrl("http://[2606:4700:4700::1111]/x.png");
    assert.equal(result.valid, true);
    assert.equal(seen, "2606:4700:4700::1111");
    assert.deepEqual(result.addresses, [{ address: "2606:4700:4700::1111", family: 6 }]);
  } finally {
    resetDnsLookupForTests();
  }
});

test("resolveAndValidateRemoteUrl rejects hostnames that resolve to private addresses", async () => {
  setDnsLookupForTests(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.7", family: 4 }, // one bad record poisons the answer
  ]);
  try {
    const result = await resolveAndValidateRemoteUrl("http://rebind.example.com/x.png");
    assert.equal(result.valid, false);
    assert.equal(result.error, PRIVATE_HOST_ERROR);
    assert.equal(result.statusCode, 403);
  } finally {
    resetDnsLookupForTests();
  }
});

test("resolveAndValidateRemoteUrl reports DNS failures as 502", async () => {
  setDnsLookupForTests(async () => { throw new Error("ENOTFOUND"); });
  try {
    const result = await resolveAndValidateRemoteUrl("http://nx.example.com/x.png");
    assert.equal(result.valid, false);
    assert.equal(result.error, DNS_RESOLUTION_ERROR);
    assert.equal(result.statusCode, 502);
  } finally {
    resetDnsLookupForTests();
  }
});

// --- shared-deadline behaviour of the DNS step (Finding 2) -------------------

test("resolveAndValidateRemoteUrl rejects immediately when the signal is already aborted", async () => {
  let lookups = 0;
  setDnsLookupForTests(async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      resolveAndValidateRemoteUrl("http://example.com/x.png", { signal: controller.signal }),
      { name: "AbortError" },
    );
    assert.equal(lookups, 0, "no DNS query may start after the deadline");
  } finally {
    resetDnsLookupForTests();
  }
});

test("resolveAndValidateRemoteUrl abandons a stalled lookup as soon as the signal fires", async () => {
  setDnsLookupForTests(() => new Promise(() => {})); // never settles
  try {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(
      // The default DNS timeout is 2 s; the shared signal must win long before.
      resolveAndValidateRemoteUrl("http://stalled.example.com/x.png", { signal: controller.signal }),
      { name: "AbortError" },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `expected prompt abort, took ${elapsed} ms`);
  } finally {
    resetDnsLookupForTests();
  }
});

test("resolveAndValidateRemoteUrl discards a lookup that completes after the deadline", async () => {
  setDnsLookupForTests(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return [{ address: "93.184.216.34", family: 4 }];
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      resolveAndValidateRemoteUrl("http://late.example.com/x.png", { signal: controller.signal }),
      { name: "AbortError" },
    );
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the late answer arrive
  } finally {
    resetDnsLookupForTests();
  }
});

test("resolveAndValidateRemoteUrl still honours its own DNS timeout without a signal", async () => {
  setDnsLookupForTests(() => new Promise(() => {}));
  try {
    const result = await resolveAndValidateRemoteUrl("http://stalled.example.com/x.png", { timeoutMs: 60 });
    assert.equal(result.valid, false);
    assert.equal(result.error, DNS_RESOLUTION_ERROR);
    assert.equal(result.statusCode, 502);
  } finally {
    resetDnsLookupForTests();
  }
});
