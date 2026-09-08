import dns from "node:dns/promises";
import net from "node:net";

export const INVALID_URL_ERROR = "Invalid URL. Only HTTP and HTTPS URLs are supported.";
export const PRIVATE_HOST_ERROR = "Requests to private or local addresses are not allowed.";
export const DNS_RESOLUTION_ERROR = "Unable to resolve the remote host.";

let dnsLookup = defaultDnsLookup;
async function defaultDnsLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export function setDnsLookupForTests(lookup) { dnsLookup = lookup; }
export function resetDnsLookupForTests() { dnsLookup = defaultDnsLookup; }

function ipv4ToNumber(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIpv4(value) {
  const n = ipv4ToNumber(value);
  if (n === null) return true;
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function expandIpv6(value) {
  let address = value.toLowerCase();
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = ipv4ToNumber(address.slice(lastColon + 1));
    if (ipv4 === null) return null;
    address = `${address.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
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
  const normalized = value.toLowerCase();
  const groups = expandIpv6(normalized);
  if (!groups || groups.length !== 8) return true;
  const allZero = groups.every((x) => x === 0);
  const loopback = groups.slice(0, 7).every((x) => x === 0) && groups[7] === 1;
  const first16 = groups[0];
  const linkLocal = first16 >= 0xfe80 && first16 <= 0xfebf;
  const uniqueLocal = first16 >= 0xfc00 && first16 <= 0xfdff;
  const multicast = first16 >= 0xff00 && first16 <= 0xffff;
  const mapped = groups.slice(0, 5).every((x) => x === 0) && groups[5] === 0xffff;
  if (mapped) {
    const ip = [groups[6] >>> 8, groups[6] & 255, groups[7] >>> 8, groups[7] & 255].join(".");
    return isPrivateIpv4(ip);
  }
  return allZero || loopback || linkLocal || uniqueLocal || multicast;
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

export function validateRemoteUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) return { valid: false, error: INVALID_URL_ERROR, statusCode: 400 };
  if (isPrivateHost(url.hostname)) return { valid: false, error: PRIVATE_HOST_ERROR, statusCode: 403 };
  return { valid: true, url: url.toString() };
}

export async function resolveAndValidateRemoteUrl(value) {
  const validation = validateRemoteUrl(value);
  if (!validation.valid) return validation;
  try {
    const records = await dnsLookup(new URL(validation.url).hostname);
    if (!Array.isArray(records) || records.length === 0 || records.some((record) => isPrivateIp(record.address))) {
      return { valid: false, error: PRIVATE_HOST_ERROR, statusCode: 403 };
    }
  } catch {
    return { valid: false, error: DNS_RESOLUTION_ERROR, statusCode: 502 };
  }
  return validation;
}
