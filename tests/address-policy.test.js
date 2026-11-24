// Address-policy tests (network-free).
//
// The policy lives in util/validate.js as explicit IPv4/IPv6 allow and deny
// CIDR tables plus a "global unicast only" rule for IPv6. These tests verify every
// table entry at its boundaries, using independent BigInt arithmetic rather
// than the implementation's own matching, and then pin a set of hand-written
// fixtures taken from the IANA special-purpose registries.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_IPV4_CIDRS,
  ALLOWED_IPV6_CIDRS,
  BLOCKED_IPV4_CIDRS,
  BLOCKED_IPV6_CIDRS,
  IPV6_GLOBAL_UNICAST_CIDR,
  PRIVATE_HOST_ERROR,
  createPinnedLookup,
  isPrivateIp,
  resolveAndValidateRemoteUrl,
} from "../util/validate.js";

// --- independent address arithmetic ---------------------------------------

function parse4(text) {
  return text.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
}

function format4(value) {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join(".");
}

function parse6(text) {
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = text.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  assert.equal(groups.length, 8, text);
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
}

function format6(value) {
  return Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)).join(":");
}

function toRange(cidr, bits, parse) {
  const [address, prefix] = cidr.split("/");
  const size = 1n << BigInt(bits - Number(prefix));
  const first = parse(address);
  return { cidr, first, last: first + size - 1n };
}

const V4_RANGES = BLOCKED_IPV4_CIDRS.map(([cidr]) => toRange(cidr, 32, parse4));
const V6_RANGES = BLOCKED_IPV6_CIDRS.map(([cidr]) => toRange(cidr, 128, parse6));
const V4_ALLOWED_RANGES = ALLOWED_IPV4_CIDRS.map(([cidr]) => toRange(cidr, 32, parse4));
const V6_ALLOWED_RANGES = ALLOWED_IPV6_CIDRS.map(([cidr]) => toRange(cidr, 128, parse6));
const GLOBAL_UNICAST = toRange(IPV6_GLOBAL_UNICAST_CIDR, 128, parse6);

const inAny = (ranges, n) => ranges.some((r) => n >= r.first && n <= r.last);
const expectedBlocked4 = (n) => inAny(V4_RANGES, n) && !inAny(V4_ALLOWED_RANGES, n);
const expectedBlocked6 = (n) =>
  (n < GLOBAL_UNICAST.first || n > GLOBAL_UNICAST.last || inAny(V6_RANGES, n))
  && !inAny(V6_ALLOWED_RANGES, n);

// --- table-driven boundary tests -------------------------------------------

test("every blocked IPv4 CIDR is rejected at both ends and allowed just outside", () => {
  assert.ok(V4_RANGES.length > 0);
  for (const range of V4_RANGES) {
    for (const n of [range.first, range.first + 1n, (range.first + range.last) / 2n, range.last]) {
      assert.equal(isPrivateIp(format4(n)), true, `${range.cidr}: ${format4(n)} must be blocked`);
    }
    for (const n of [range.first - 1n, range.last + 1n]) {
      if (n < 0n || n > 0xffffffffn) continue;
      assert.equal(
        isPrivateIp(format4(n)),
        expectedBlocked4(n),
        `${range.cidr}: neighbour ${format4(n)} classified incorrectly`,
      );
    }
  }
});

test("every blocked IPv6 carve-out is rejected at both ends and allowed just outside", () => {
  assert.ok(V6_RANGES.length > 0);
  for (const range of V6_RANGES) {
    for (const n of [range.first, range.first + 1n, (range.first + range.last) / 2n, range.last]) {
      assert.equal(isPrivateIp(format6(n)), true, `${range.cidr}: ${format6(n)} must be blocked`);
    }
    for (const n of [range.first - 1n, range.last + 1n]) {
      assert.equal(
        isPrivateIp(format6(n)),
        expectedBlocked6(n),
        `${range.cidr}: neighbour ${format6(n)} classified incorrectly`,
      );
    }
  }
});

test("IPv6 global-unicast boundary: only 2000::/3 is a candidate", () => {
  assert.equal(isPrivateIp(format6(GLOBAL_UNICAST.first - 1n)), true); // 1fff:ffff:...
  assert.equal(isPrivateIp(format6(GLOBAL_UNICAST.last + 1n)), true); //  4000::
  // Edges of 2000::/3 are allowed unless a carve-out covers them.
  assert.equal(isPrivateIp("2000::1"), false);
  assert.equal(isPrivateIp("3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), false);
});

test("policy tables are valid: no duplicate or overlapping entries", () => {
  for (const ranges of [V4_RANGES, V6_RANGES, V4_ALLOWED_RANGES, V6_ALLOWED_RANGES]) {
    const sorted = [...ranges].sort((a, b) => (a.first < b.first ? -1 : 1));
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(sorted[i].first > sorted[i - 1].last, `${sorted[i - 1].cidr} overlaps ${sorted[i].cidr}`);
    }
  }
  for (const range of V6_RANGES) {
    assert.ok(range.first >= GLOBAL_UNICAST.first && range.last <= GLOBAL_UNICAST.last,
      `${range.cidr} is outside ${IPV6_GLOBAL_UNICAST_CIDR} and therefore redundant`);
  }
});

// --- hand-written fixtures (independent of the tables above) ----------------

test("more-specific globally reachable IANA allocations are not blocked by parent ranges", async () => {
  const allowed4 = ALLOWED_IPV4_CIDRS.map(([cidr]) => cidr.split("/")[0]);
  for (const ip of allowed4) assert.equal(isPrivateIp(ip), false, ip);
  for (const ip of ["192.0.0.8", "192.0.0.11", "192.0.0.170", "192.0.0.171"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }

  const allowed6 = [
    "2001:1::1", "2001:1::2", "2001:1::3", "2001:3::1",
    "2001:4:112::1", "2001:20::1", "2001:30::1",
  ];
  for (const ip of allowed6) assert.equal(isPrivateIp(ip), false, ip);
  for (const ip of ["2001::1", "2001:1::4", "2001:2::1", "2001:4:111::1", "2001:40::1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }

  for (const ip of ["192.0.0.9", "192.0.0.10", "[2001:1::1]", "[2001:20::1]"]) {
    const result = await resolveAndValidateRemoteUrl(`https://${ip}/image.png`);
    assert.equal(result.valid, true, `${ip} must pass the URL validation path`);
    assert.equal(result.addresses.length, 1, `${ip} must be pinned as a literal`);
  }

  // The exceptions are intentionally more specific than their parent deny ranges.
  assert.ok(ALLOWED_IPV4_CIDRS.every(([cidr]) =>
    V4_RANGES.some((range) => {
      const allowed = toRange(cidr, 32, parse4);
      return allowed.first >= range.first && allowed.last <= range.last;
    }),
  ));
  assert.ok(ALLOWED_IPV6_CIDRS.every(([cidr]) =>
    V6_RANGES.some((range) => {
      const allowed = toRange(cidr, 128, parse6);
      return allowed.first >= range.first && allowed.last <= range.last;
    }),
  ));

  // Check every exception's full boundaries, not just one address from each
  // allocation, and verify that the immediately adjacent addresses retain
  // the parent-range deny policy (except where another explicit exception is
  // adjacent, as with the two IPv4 anycasts).
  for (const [ranges, format, max, expectedBlocked] of [
    [V4_ALLOWED_RANGES, format4, 0xffffffffn, expectedBlocked4],
    [V6_ALLOWED_RANGES, format6, (1n << 128n) - 1n, expectedBlocked6],
  ]) {
    for (const range of ranges) {
      const samples = new Set([range.first, range.last]);
      if (range.first < range.last) {
        samples.add(range.first + 1n);
        samples.add((range.first + range.last) / 2n);
      }
      for (const n of samples) {
        assert.equal(isPrivateIp(format(n)), false, `${range.cidr}: ${format(n)} must be allowed`);
      }
      for (const n of [range.first - 1n, range.last + 1n]) {
        if (n < 0n || n > max) continue;
        assert.equal(isPrivateIp(format(n)), expectedBlocked(n),
          `${range.cidr}: neighbour ${format(n)} classified incorrectly`);
      }
    }
  }
});

test("IPv4 documentation, benchmarking, relay and reserved ranges are rejected", () => {
  for (const ip of [
    "192.0.2.0", "192.0.2.1", "192.0.2.255", //            TEST-NET-1
    "198.51.100.0", "198.51.100.77", "198.51.100.255", //  TEST-NET-2
    "203.0.113.0", "203.0.113.9", "203.0.113.255", //      TEST-NET-3
    "192.88.99.1", //                                       deprecated 6to4 relay
    "198.18.0.0", "198.19.255.255", //                      benchmarking
    "240.0.0.1", "255.255.255.255", //                      reserved / broadcast
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("neighbouring public IPv4 addresses stay allowed", () => {
  for (const ip of [
    "192.0.1.1", "192.0.3.1", "198.17.255.255", "198.20.0.0",
    "198.51.99.255", "198.51.101.0", "203.0.112.255", "203.0.114.0",
    "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0",
    "8.8.8.8", "1.1.1.1", "223.255.255.255",
    // Only 192.0.0.0/24 and 192.0.2.0/24 are special-purpose. The rest of
    // 192.0.0.0/16 is ordinary public space (it hosts real image CDNs), which
    // an over-broad "192.0.x.x" rule used to reject.
    "192.0.43.8", "192.0.64.1", "192.0.78.1", "192.0.255.255",
  ]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("special-purpose IPv6 ranges are rejected", () => {
  for (const ip of [
    "::", "::1", "::2", "::8.8.8.8", //          unspecified, loopback, deprecated IPv4-compatible
    "2001:db8::1", "2001:db8:ffff::1", //         documentation
    "3fff::1", "3fff:fff:ffff::1", //             documentation (RFC 9637)
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "2001:2::1", "2001:10::1", //                benchmarking, deprecated ORCHID
    "100::1", //                                  discard-only
    "64:ff9b:1::1", //                            local-use NAT64
    "5f00::1", //                                 SRv6 SIDs
    "fc00::1", "fdff::1", //                      unique local
    "fe80::1", "febf::1", "fec0::1", //           link-local and site-local
    "ff02::1", "ff00::", //                       multicast
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("public IPv6 addresses are not blanket-blocked", () => {
  for (const ip of [
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::200e",
    "2001:200::1", "2001:db7::1", "2001:db9::1", "2400:cb00::1", "2620:fe::fe",
  ]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("embedded-IPv4 IPv6 forms are judged by the embedded address", () => {
  const cases = [
    // [address, expected blocked]
    ["::ffff:192.0.2.1", true],
    ["::ffff:c000:201", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:8.8.8.8", false],
    ["::ffff:192.0.0.9", false], // globally reachable PCP Anycast exception
    ["64:ff9b::c000:201", true], //   NAT64 -> TEST-NET-1
    ["64:ff9b::a9fe:a9fe", true], //  NAT64 -> metadata address
    ["64:ff9b::808:808", false], //   NAT64 -> 8.8.8.8
    ["64:ff9b::c000:9", false], //     NAT64 -> globally reachable PCP Anycast
    ["2002:c000:201::1", true], //    6to4  -> TEST-NET-1
    ["2002:7f00:1::1", true], //      6to4  -> loopback
    ["2002:808:808::1", false], //    6to4  -> 8.8.8.8
    ["2002:c000:9::1", false], //     6to4  -> globally reachable PCP Anycast
  ];
  for (const [ip, blocked] of cases) {
    assert.equal(isPrivateIp(ip), blocked, ip);
  }
});

test("malformed addresses fail closed", () => {
  for (const value of ["", "not-an-ip", "1.2.3", "1.2.3.4.5", "256.1.1.1", "2001:db8:::1", "fe80::1%eth0"]) {
    assert.equal(isPrivateIp(value), true, JSON.stringify(value));
  }
});

// An empty answer means the name did not resolve. It is not a private address,
// so it must not be reported as 403 (docs/backend-contract.md: 502 for DNS failure).
test("a DNS answer with no addresses is a resolution failure (502), not a private host (403)", async () => {
  const dns = (await import("node:dns/promises")).default;
  const realLookup = dns.lookup;
  dns.lookup = async () => [];
  try {
    const result = await resolveAndValidateRemoteUrl("http://dns-empty.test/a.png");
    assert.equal(result.valid, false);
    assert.equal(result.statusCode, 502);
  } finally {
    dns.lookup = realLookup;
  }
});

// Replaces dns.lookup for one call, so a hostname's DNS answer can be chosen
// (no network access) while the real validation and pinning code runs.
async function withDnsAnswer(answer, run) {
  const dns = (await import("node:dns/promises")).default;
  const realLookup = dns.lookup;
  dns.lookup = async () => answer;
  try {
    return await run();
  } finally {
    dns.lookup = realLookup;
  }
}

test("a hostname whose DNS answer is public is pinned to exactly those addresses", async () => {
  const answer = [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  const result = await withDnsAnswer(answer, () => resolveAndValidateRemoteUrl("http://public-host.test/a.png"));
  assert.equal(result.valid, true);
  assert.deepEqual(result.addresses, answer);
});

test("a hostname with any private address in its DNS answer is rejected with 403", async () => {
  for (const answer of [
    [{ address: "10.0.0.7", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }],
    [{ address: "2606:4700:4700::1111", family: 6 }, { address: "fd00::1", family: 6 }],
  ]) {
    const result = await withDnsAnswer(answer, () => resolveAndValidateRemoteUrl("http://mixed-host.test/a.png"));
    assert.equal(result.valid, false, JSON.stringify(answer));
    assert.equal(result.statusCode, 403, JSON.stringify(answer));
    assert.equal(result.error, PRIVATE_HOST_ERROR, JSON.stringify(answer));
  }
});

test("public IP literals are pinned directly without DNS; the deadline still wins", async () => {
  const v4 = await resolveAndValidateRemoteUrl("http://8.8.8.8/a.png");
  assert.deepEqual(v4.addresses, [{ address: "8.8.8.8", family: 4 }]);
  const v6 = await resolveAndValidateRemoteUrl("https://[2606:4700:4700::1111]/a.png");
  assert.equal(v6.valid, true);
  assert.deepEqual(v6.addresses, [{ address: "2606:4700:4700::1111", family: 6 }]);
  assert.equal((await resolveAndValidateRemoteUrl("http://[::ffff:a9fe:a9fe]/")).statusCode, 403);

  const controller = new AbortController();
  controller.abort(new Error("deadline"));
  await assert.rejects(
    resolveAndValidateRemoteUrl("http://8.8.8.8/a.png", { signal: controller.signal }),
    /deadline/,
  );
});

test("pinned DNS lookup honours requested family for single and all results", () => {
  const records = [
    { address: "2001:4860:4860::8888", family: 6 },
    { address: "8.8.8.8", family: 4 },
    { address: "2001:4860:4860::8844", family: 6 },
  ];
  const lookup = createPinnedLookup(records);

  lookup("proxy.test", { family: 4 }, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, "8.8.8.8");
    assert.equal(family, 4);
  });
  lookup("proxy.test", 6, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, "2001:4860:4860::8888");
    assert.equal(family, 6);
  });
  lookup("proxy.test", { family: "IPv6", all: true }, (error, addresses) => {
    assert.ifError(error);
    assert.deepEqual(addresses, [records[0], records[2]]);
  });
  lookup("proxy.test", { all: true, family: "IPv4" }, (error, addresses) => {
    assert.ifError(error);
    assert.deepEqual(addresses, [records[1]]);
  });
  lookup("proxy.test", (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, records[0].address);
    assert.equal(family, records[0].family);
  });

  const ipv4OnlyLookup = createPinnedLookup([records[1]]);
  ipv4OnlyLookup("proxy.test", { family: 6 }, (error) => {
    assert.equal(error?.code, "EAI_ADDRFAMILY");
  });
});

