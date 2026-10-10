import dns from "node:dns/promises";
import net from "node:net";

export const INVALID_URL_ERROR = "Invalid URL. Only HTTP and HTTPS URLs are supported.";
export const PRIVATE_HOST_ERROR = "Requests to private or local addresses are not allowed.";
export const DNS_RESOLUTION_ERROR = "Unable to resolve the remote host.";
const DNS_LOOKUP_TIMEOUT_MS = 2_000;

let dnsLookup = defaultDnsLookup;
async function defaultDnsLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export function setDnsLookupForTests(lookup) { dnsLookup = lookup; }
export function resetDnsLookupForTests() { dnsLookup = defaultDnsLookup; }

// ---------------------------------------------------------------------------
// Address policy
//
// The proxy only ever connects to addresses that are plausibly *public
// internet* hosts. The policy is deliberately explicit and table-driven so it
// can be audited against the IANA special-purpose registries:
//   https://www.iana.org/assignments/iana-ipv4-special-registry/
//   https://www.iana.org/assignments/iana-ipv6-special-registry/
//   https://www.iana.org/assignments/ipv6-address-space/
//
// IPv4: every IANA special-purpose block that is not a globally routable
// unicast range is rejected. Everything else is allowed.
//
// IPv6: only 2000::/3 (the IANA-designated global-unicast space) is a
// candidate at all; every address outside it is rejected. Inside 2000::/3 the
// special-purpose carve-outs below are rejected, and everything else stays
// allowed. This is NOT a blanket block of allocated IPv6 space.
//
// IPv6 forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4) are judged
// by the embedded IPv4 address instead, because a gateway would forward there.
// ---------------------------------------------------------------------------
export const BLOCKED_IPV4_CIDRS = Object.freeze([
  ["0.0.0.0/8", "'This network' (RFC 1122)"],
  ["10.0.0.0/8", "Private use (RFC 1918)"],
  ["100.64.0.0/10", "Shared address space / CGNAT (RFC 6598)"],
  ["127.0.0.0/8", "Loopback (RFC 1122)"],
  ["169.254.0.0/16", "Link-local, incl. cloud metadata (RFC 3927)"],
  ["172.16.0.0/12", "Private use (RFC 1918)"],
  ["192.0.0.0/24", "IETF protocol assignments (RFC 6890)"],
  ["192.0.2.0/24", "Documentation, TEST-NET-1 (RFC 5737)"],
  ["192.88.99.0/24", "Deprecated 6to4 relay anycast (RFC 7526)"],
  ["192.168.0.0/16", "Private use (RFC 1918)"],
  ["198.18.0.0/15", "Benchmarking (RFC 2544)"],
  ["198.51.100.0/24", "Documentation, TEST-NET-2 (RFC 5737)"],
  ["203.0.113.0/24", "Documentation, TEST-NET-3 (RFC 5737)"],
  ["224.0.0.0/4", "Multicast (RFC 5771)"],
  ["240.0.0.0/4", "Reserved for future use, incl. broadcast (RFC 1112)"],
]);

// Carve-outs *inside* 2000::/3. Addresses outside 2000::/3 are rejected by
// the global-unicast rule in isPrivateIpv6() and are not repeated here (that
// includes e.g. 5f00::/16, the SRv6 SID block from RFC 9602).
export const IPV6_GLOBAL_UNICAST_CIDR = "2000::/3";
export const BLOCKED_IPV6_CIDRS = Object.freeze([
  ["2001::/23", "IETF protocol assignments: Teredo, benchmarking, ORCHID, AMT, ... (RFC 2928)"],
  ["2001:db8::/32", "Documentation (RFC 3849)"],
  ["3fff::/20", "Documentation (RFC 9637)"],
]);

function buildBlockList(entries, family) {
  const list = new net.BlockList();
  for (const [cidr] of entries) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

const BLOCKED_IPV4 = buildBlockList(BLOCKED_IPV4_CIDRS, "ipv4");
const BLOCKED_IPV6 = buildBlockList(BLOCKED_IPV6_CIDRS, "ipv6");

function isPrivateIpv4(value) {
  // Callers pass a string that net.isIP() already classified as IPv4; the
  // format check is kept so malformed input fails closed.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  if (value.split(".").some((part) => Number(part) > 255)) return true;
  return BLOCKED_IPV4.check(value, "ipv4");
}

function expandIpv6(value) {
  let address = value.toLowerCase();
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const octets = address.slice(lastColon + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    const high = (octets[0] << 8) | octets[1];
    const low = (octets[2] << 8) | octets[3];
    address = `${address.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const parts = address.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  if (left.some((x) => !/^[0-9a-f]{1,4}$/.test(x)) || right.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  const missing = 8 - left.length - right.length;
  if (parts.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...left, ...(parts.length === 2 ? Array(missing).fill("0") : []), ...right].map((x) => parseInt(x || "0", 16));
}

function isPrivateIpv6(value) {
  const groups = expandIpv6(value);
  if (!groups || groups.length !== 8) return true;
  const toIpv4 = (high, low) => [high >>> 8, high & 255, low >>> 8, low & 255].join(".");

  // IPv4-mapped (::ffff:0:0/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16)
  // embed an IPv4 address that a gateway would forward to; judge them by that
  // address so e.g. ::ffff:169.254.169.254 cannot slip past the filter.
  if (groups.slice(0, 5).every((x) => x === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4(toIpv4(groups[6], groups[7]));
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIpv4(toIpv4(groups[6], groups[7]));
  }
  if (groups[0] === 0x2002) return isPrivateIpv4(toIpv4(groups[1], groups[2]));

  // Default-deny outside global unicast (2000::/3). This covers unspecified,
  // loopback, deprecated IPv4-compatible (::/96), local-use NAT64
  // (64:ff9b:1::/48), discard (100::/64), ULA (fc00::/7), link-local
  // (fe80::/10), deprecated site-local (fec0::/10) and multicast (ff00::/8).
  if ((groups[0] & 0xe000) !== 0x2000) return true;

  return BLOCKED_IPV6.check(groups.map((x) => x.toString(16)).join(":"), "ipv6");
}

export function isPrivateIp(value) {
  const address = String(value).trim().replace(/^\[/, "").replace(/\]$/, "");
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

const PRIVATE_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "local", "ip6-localhost", "ip6-loopback"]);
export function isPrivateHost(hostname) {
  const host = String(hostname).trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase().replace(/\.$/, "");
  if (PRIVATE_HOSTNAMES.has(host)) return true;
  return net.isIP(host) ? isPrivateIp(host) : false;
}

export function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    return url;
  } catch { return null; }
}

// Internal building block of resolveAndValidateRemoteUrl(). Not exported:
// the pre-fetch check in functions/index.js uses parseHttpUrl + isPrivateHost
// directly, so an exported copy here would be a dead public API that can drift
// from the DNS-validated path.
function validateRemoteUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) return { valid: false, error: INVALID_URL_ERROR, statusCode: 400 };
  if (isPrivateHost(url.hostname)) return { valid: false, error: PRIVATE_HOST_ERROR, statusCode: 403 };
  return { valid: true, url: url.toString() };
}

// `options.signal` is the caller's shared deadline. When it fires, the DNS
// wait is abandoned immediately (the signal's reason is thrown) instead of
// lingering until the 2 s DNS timeout, and no result is returned for the caller
// to act on after the deadline. `options.timeoutMs` overrides the DNS timeout.
export async function resolveAndValidateRemoteUrl(value, options = {}) {
  const { signal, timeoutMs = DNS_LOOKUP_TIMEOUT_MS } = options;
  const validation = validateRemoteUrl(value);
  if (!validation.valid) return validation;

  signal?.throwIfAborted();

  // URL#hostname keeps the brackets on IPv6 literals ("[2606:4700::1111]"),
  // which getaddrinfo cannot resolve. Strip them so public IPv6 literals work.
  const hostname = new URL(validation.url).hostname.replace(/^\[|\]$/g, "");
  let records;
  let timer;
  let onAbort;
  try {
    records = await Promise.race([
      dnsLookup(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS_TIMEOUT")), timeoutMs);
      }),
      new Promise((_, reject) => {
        if (!signal) return;
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { valid: false, error: DNS_RESOLUTION_ERROR, statusCode: 502 };
  } finally {
    // Don't leave a dangling timer/listener per request once the lookup settled.
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }

  // A lookup that finished in the same tick as the deadline must not be acted on.
  signal?.throwIfAborted();

  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.some((record) => isPrivateIp(record.address))
  ) {
    return { valid: false, error: PRIVATE_HOST_ERROR, statusCode: 403 };
  }

  // Callers should pin the actual socket to these exact addresses (see
  // createPinnedLookup below) instead of letting the HTTP client re-resolve
  // the hostname at connect time. Otherwise a low-TTL DNS answer can rebind to a
  // private address in the gap between this check and the connection
  // (TOCTOU DNS rebinding) even though this lookup was clean.
  return {
    ...validation,
    addresses: records.map(({ address, family }) => ({ address, family })),
  };
}

// Builds a Node-style `lookup(hostname, options, callback)` function that
// always answers with the given pre-validated addresses, regardless of what
// a live DNS query would return. Pass it as the `lookup` option of
// http/https.request (see requestPinned in functions/index.js) to pin a
// request to addresses that have already been checked by
// resolveAndValidateRemoteUrl.
export function createPinnedLookup(records) {
  return function pinnedLookup(hostname, options, callback) {
    const opts = options && typeof options === "object" ? options : {};
    if (opts.all) {
      callback(null, records.map(({ address, family }) => ({ address, family })));
      return;
    }
    const wantedFamily = opts.family || 0;
    const match = (wantedFamily && records.find((r) => r.family === wantedFamily)) || records[0];
    callback(null, match.address, match.family);
  };
}
