import http from "node:http";
import https from "node:https";

import { resolveAndValidateRemoteUrl, createPinnedLookup } from "../util/validate.js";
import { PROXY_VERSION, API_VERSION, FEATURES } from "../util/version.js";
import { BASE_HEADERS, createResponse } from "../util/headers.js";
import { loadSharp } from "../util/sharp.js";

// Sharp's metadata().format values mapped to real media types. AVIF and HEIC
// are both reported as "heif" and told apart by metadata().compression (see
// getDetectedContentType below).
const DETECTED_IMAGE_TYPES = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
  jxl: "image/jxl",
  svg: "image/svg+xml",
});

// Formats every Chromium-based browser (Bandwidth Guardian's targets) can
// display. Untouched original bytes are only ever returned for WebP requests
// when they are one of these; anything else (TIFF, HEIC, JXL, SVG, ...) is
// always served as WebP, even when the WebP encoding is larger.
const BROWSER_SAFE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

const DEFAULT_QUALITY = 60;
const DEFAULT_MAX_WIDTH = 0;
const FETCH_TIMEOUT_MS = 8_000;
// Socket inactivity timeout, deliberately shorter than the shared 8 s
// deadline so slow-drip protection between bytes fires BEFORE the deadline.
// It aborts the same controller as the deadline, so both report 504.
const SOCKET_INACTIVITY_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Conservative default for serverless memory headroom; raise only after load
// testing. For multi-frame input Sharp counts the pixels of all frames together.
const MAX_INPUT_PIXELS = 6_000_000;
// Sharp disables its own processing timeout by default. Bound each libvips
// pipeline so a stalled decode/encode can be mapped to an actionable 504.
const SHARP_PROCESSING_TIMEOUT_SECONDS = 8;
// Netlify buffered Functions have a 6 MB response limit; Lambda-style
// binary responses are base64 encoded, so keep a safety margin below it.
const MAX_FUNCTION_OUTPUT_BYTES = 4_300_000;
// Whole-request budget, measured from handler entry. No new fallback encode
// starts after it, so an oversized image ends with a clear 504 instead of the
// platform killing the function with an opaque gateway error.
const REQUEST_BUDGET_MS = 20_000;
// Fallback encodes allowed after the first (requested-settings) encode.
const MAX_FALLBACK_ENCODES = 5;
// Encoded size scales roughly with pixel area, i.e. with width squared. The
// width estimate aims slightly below the cap so one probe usually suffices.
const WIDTH_ESTIMATE_SAFETY = 0.85;
// A fit below this fraction of the cap keeps searching for a wider one
// (within the encode budget) instead of being accepted immediately.
const UNDERSHOOT_RATIO = 0.25;

// The upstream Accept header is fixed instead of forwarding the client's. The
// response is cached publicly by query only, so a CDN that negotiates on
// Accept must not hand one client's format (e.g. JPEG XL) to everyone else.
// Re-encoded output is unaffected; this only matters for original bytes.
const UPSTREAM_ACCEPT = "image/webp,image/avif,image/apng,image/png,image/jpeg,image/gif;q=0.9,image/*;q=0.8,*/*;q=0.5";
// User-Agent and Accept-Language are fixed for the same reason as Accept: the
// response is cached by query only, so a CDN that varies on them (mobile or
// low-res variants, localized images) must not have one client's variant
// cached for everyone.
const UPSTREAM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const UPSTREAM_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
// Pass-through request headers. Cookie is deliberately NOT forwarded: a
// browser only sends the proxy origin's own cookies here, and forwarding them
// to arbitrary upstream hosts would leak them. Referer is kept for hotlink
// protection and stripped on cross-origin redirects.
const FORWARDED_REQUEST_HEADERS = ["dnt", "referer"];

// Browser cache is deliberately short-lived because extension settings are
// encoded into the URL. Netlify's CDN keeps the expensive compressed result.
const PUBLIC_CACHE_HEADERS = Object.freeze({
  "cache-control": "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800",
  "netlify-cdn-cache-control": "public, durable, s-maxage=2592000, stale-while-revalidate=604800",
  "netlify-vary": "query=url|quality|bw|jpeg|max_width|l",
});
// Legacy clients that do not encode the upstream URL leak its query string
// into the outer one as extra keys. Those keys are part of the image URL, so
// such responses must vary on the whole query string.
const LEGACY_PUBLIC_CACHE_HEADERS = Object.freeze({
  ...PUBLIC_CACHE_HEADERS,
  "netlify-vary": "query",
});
const PRIVATE_CACHE_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
});
const TEXT_ERROR_HEADERS = Object.freeze({
  "content-type": "text/plain; charset=utf-8",
  ...PRIVATE_CACHE_HEADERS,
});

// Runtime limits live in one frozen object so the integration tests can shrink
// them without touching the production defaults or exposing them to requests.
// Nothing in the request path can modify this; only configureForTests() can.
const DEFAULT_SETTINGS = Object.freeze({
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  socketTimeoutMs: SOCKET_INACTIVITY_TIMEOUT_MS,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxOutputBytes: MAX_FUNCTION_OUTPUT_BYTES,
  requestBudgetMs: REQUEST_BUDGET_MS,
  resolveRemoteUrl: resolveAndValidateRemoteUrl,
});
let settings = DEFAULT_SETTINGS;

// Merges into the CURRENT settings instead of resetting to defaults first:
// an overrides-only call must not silently restore the real DNS resolver
// (which would cause accidental network calls in CI).
export function configureForTests(overrides = {}) {
  settings = Object.freeze({ ...settings, ...overrides });
}
export function resetConfigForTests() {
  settings = DEFAULT_SETTINGS;
}

async function getSharp() {
  try {
    return await loadSharp();
  } catch (error) {
    const wrapped = createHttpError(503, "Image processor is unavailable on the Netlify runtime.");
    wrapped.cause = error;
    throw wrapped;
  }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createTimeoutError(message) {
  return new DOMException(message, "TimeoutError");
}

function createBinaryResponse(buffer, headers, cacheHeaders) {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    body: buffer.toString("base64"),
    headers: {
      ...BASE_HEADERS,
      ...cacheHeaders,
      ...headers,
    },
  };
}

// Extracts the upstream image URL from the raw query string.
//
// Bandwidth Guardian (and every current client) sends
// url=encodeURIComponent(imageUrl): the value cannot contain a raw "&", so it
// ends at the next "&" and is decoded once.
//
// Legacy clients send the image URL unencoded. Its own "?a=b&c=d" query then
// leaks into the outer query string as separate keys (`c`), which Netlify's
// parsed queryStringParameters would silently drop. An unencoded value starts
// with "http(s)://"; it is taken verbatim up to the first proxy parameter.
//
// Falls back to the parsed `url` parameter when no raw query is available.
const PROXY_PARAMETER = /&(?:quality|l|bw|jpeg|max_width)=/;
export function getImageUrl(event = {}) {
  const raw = String(event.rawQuery ?? "").replace(/^\?/, "");
  const match = /(?:^|&)url=/.exec(raw);
  if (!match) {
    const parsed = event.queryStringParameters?.url;
    return { url: typeof parsed === "string" ? parsed : "", legacy: false };
  }

  let value = raw.slice(match.index + match[0].length);
  if (/^https?:\/\//i.test(value)) {
    const end = value.search(PROXY_PARAMETER);
    if (end >= 0) value = value.slice(0, end);
    return { url: value, legacy: value.includes("&") };
  }

  const end = value.indexOf("&");
  if (end >= 0) value = value.slice(0, end);
  try {
    // "+" is a space in query strings; encodeURIComponent never emits it.
    return { url: decodeURIComponent(value.replace(/\+/g, " ")), legacy: false };
  } catch {
    return { url: value, legacy: false };
  }
}

// Exported for tests. The 1.1.x.x/bmi/ prefix is a legacy carrier-proxy
// (Bandwidth Hero era) URL wrapper that is unwrapped for compatibility.
export function normalizeImageUrl(value) {
  const raw = value
    .trim()
    .replace(/^http:\/\/1\.1\.\d+\.\d+\/bmi\/(https?:\/\/)?/i, (_, scheme) => scheme || "http://");

  // Fragments are never sent in HTTP requests. Dropping them makes equivalent
  // proxy requests share the same CDN/browser cache entry instead of creating
  // duplicate compressed variants.
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export function parseInteger(value, fallback, min, max) {
  const text = String(value ?? "").trim();
  // parseInt() accepts numeric prefixes such as "20px" or "1e2". Query
  // parameters are integers by contract, so reject malformed values entirely
  // before applying the documented default/clamp behavior.
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  const n = Number.parseInt(text, 10);
  // The pattern above guarantees digits only; a string too long for a finite
  // number parses to +/-Infinity, which the clamp turns into max/min.
  return Math.min(Math.max(n, min), max);
}

function parseBoolean(value) {
  return value === "1" || value === "true";
}

// Header names arrive with whatever casing the caller used.
function buildUpstreamHeaders(eventHeaders) {
  const incoming = {};
  for (const [name, value] of Object.entries(eventHeaders || {})) {
    incoming[String(name).toLowerCase()] = value;
  }

  const headers = {
    accept: UPSTREAM_ACCEPT,
    "accept-encoding": "identity",
    "user-agent": UPSTREAM_USER_AGENT,
    "accept-language": UPSTREAM_ACCEPT_LANGUAGE,
  };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (incoming[name]) headers[name] = incoming[name];
  }
  return headers;
}

// Node's native http/https request supports a custom `lookup` in its options
// object, so the socket is pinned to the DNS-validated addresses directly
// through a first-class, documented API — no third-party dispatcher involved.
// The pinned lookup only ever answers with the addresses that
// resolveAndValidateRemoteUrl already checked.
//
// Both the shared deadline and the socket inactivity timer go through the
// same controller, so a stall before headers, between bytes or mid-body is
// always classified the same way (504).
function requestPinned(target, upstreamHeaders, lookup, controller, socketTimeoutMs) {
  return new Promise((resolve, reject) => {
    const { signal } = controller;
    // Never initiate a new upstream request once the shared deadline has fired.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    let request;
    // The listener is removed when the exchange finishes, not only when it
    // fires; the response "close" event covers normal body completion AND any
    // mid-body destroy(), so the deadline stays armed for the whole download.
    const onAbort = () => request.destroy(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    try {
      request = transport.get(target, {
        lookup,
        headers: upstreamHeaders,
        // Fresh socket per hop; nothing pooled, nothing to leak or keep warm.
        agent: false,
      }, (response) => {
        response.once("close", cleanup);
        resolve(response);
      });
    } catch (error) {
      reject(error);
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      cleanup();
      reject(error);
    });
    // Resets on activity, so a slow-drip upstream cannot stall between bytes.
    request.setTimeout(socketTimeoutMs, () => {
      controller.abort(createTimeoutError("Upstream socket timed out."));
    });
  });
}

async function readLimitedBody(response, maxBytes) {
  const contentLength = Number.parseInt(response.headers["content-length"] || "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.destroy();
    throw createHttpError(413, "The source image is too large.");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw createHttpError(413, "The source image is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function resolveRedirect(location, base) {
  let next;
  try {
    next = new URL(location, base);
  } catch {
    throw createHttpError(502, "Upstream sent an invalid redirect location.");
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw createHttpError(502, "Upstream sent an invalid redirect location.");
  }
  return next;
}

// Internal to this module (tests exercise it through handler()).
async function fetchImage(eventHeaders, initialUrl) {
  const { fetchTimeoutMs, socketTimeoutMs: socketTimeoutSetting, maxImageBytes, resolveRemoteUrl } = settings;
  let currentUrl = initialUrl;
  // Forwarded request headers don't change across hops, except that Referer
  // is dropped when a redirect leaves the original origin.
  let upstreamHeaders = buildUpstreamHeaders(eventHeaders);
  const controller = new AbortController();
  // One deadline covers DNS, every hop AND the body download.
  const timer = setTimeout(
    () => controller.abort(createTimeoutError("Upstream image request timed out.")),
    fetchTimeoutMs,
  );
  // Tests shrink fetchTimeoutMs below the production inactivity timeout; the
  // socket timer must never outlive the shared deadline it backs up.
  const socketTimeoutMs = Math.min(socketTimeoutSetting, fetchTimeoutMs);

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      // Checked before every hop; the DNS step observes the same signal, and
      // requestPinned re-checks it before opening a socket.
      controller.signal.throwIfAborted();
      // Every hop, including the first, is URL-checked, DNS-resolved and
      // address-checked here (400 for invalid URLs, 403 for private targets).
      const validation = await resolveRemoteUrl(currentUrl, { signal: controller.signal });
      if (!validation.valid) {
        throw createHttpError(validation.statusCode || 403, validation.error);
      }

      const target = new URL(validation.url);
      const upstream = await requestPinned(
        target,
        upstreamHeaders,
        createPinnedLookup(validation.addresses),
        controller,
        socketTimeoutMs,
      );

      const location = upstream.headers.location;
      const status = upstream.statusCode || 0;
      if (status >= 300 && status < 400 && location) {
        // agent:false, so destroying the response closes the socket.
        upstream.destroy();
        if (redirect === MAX_REDIRECTS) throw createHttpError(508, "Too many upstream redirects.");
        const next = resolveRedirect(location, target);
        if (next.origin !== target.origin) {
          upstreamHeaders = { ...upstreamHeaders };
          delete upstreamHeaders.referer;
        }
        currentUrl = next.toString();
        continue;
      }

      if (status < 200 || status >= 300) {
        upstream.destroy();
        throw createHttpError(
          status >= 400 && status <= 599 ? status : 502,
          `Upstream image request failed with status ${status}.`,
        );
      }

      const contentType = String(upstream.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();

      // Keep compatibility with CDNs that omit Content-Type. Sharp validates
      // the actual bytes later. Explicit non-image responses are rejected early.
      if (contentType && !contentType.startsWith("image/")) {
        upstream.destroy();
        throw createHttpError(415, `Upstream returned a non-image response (${contentType}).`);
      }

      return {
        buffer: await readLimitedBody(upstream, maxImageBytes),
        contentType,
        headers: upstream.headers,
      };
    }
  } catch (error) {
    // The controller is aborted by the deadline AND by the socket inactivity
    // timer. A destroyed socket can surface as a plain ECONNRESET ("aborted"),
    // so the controller's own state is the reliable timeout signal.
    if (controller.signal.aborted && !Number.isInteger(error?.statusCode)) {
      throw createHttpError(504, "Upstream image request timed out.");
    }
    // Connector-level failures (ECONNREFUSED, ENETUNREACH, TLS errors) mean the
    // upstream could not be reached at all. Report them as gateway errors with
    // the underlying code so a broken deployment is diagnosable.
    if (error && !Number.isInteger(error.statusCode)) {
      const code = error.code ? ` [${error.code}]` : "";
      const gateway = createHttpError(502, `Upstream connection failed${code}.`);
      gateway.cause = error;
      throw gateway;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function getSafeUpstreamHeaders(headers) {
  const output = {};
  for (const name of ["etag", "last-modified", "expires"]) {
    const value = headers[name];
    if (value) output[name] = value;
  }
  return output;
}

function isTimeoutError(error) {
  return error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    /timeout|timed?\s*out/i.test(String(error?.message || ""));
}

// Every decode uses the same safety options; building the instance in one
// place keeps them from drifting apart.
async function createSharpPipeline(input, animated) {
  const sharp = await getSharp();
  return sharp(input, {
    animated,
    // "none" instead of Sharp's default "warning": truncated or slightly
    // corrupt JPEGs are common on real sites, and libvips treats truncation as
    // an error at every stricter level. Rejecting them made the client fall
    // back to downloading the full original, saving nothing. The pixel limit
    // and processing timeout below still apply; non-images still fail.
    failOn: "none",
    limitInputPixels: MAX_INPUT_PIXELS,
  }).timeout({ seconds: SHARP_PROCESSING_TIMEOUT_SECONDS });
}

// Header-only probe, done once per request. Its result drives the animated
// passthrough, the original-bytes media type and the WebP encoder options.
// It also runs the pixel-limit check before any decode, with the same options
// the encoders use. Sharp reports an oversized input as a plain Error; that is
// the client's input being too large (413), not a server failure (500).
async function probeImage(buffer) {
  try {
    return await (await createSharpPipeline(buffer, true)).metadata();
  } catch (error) {
    if (/exceeds pixel limit/i.test(String(error?.message || ""))) {
      const tooLarge = createHttpError(
        413,
        `The source image exceeds the ${MAX_INPUT_PIXELS / 1_000_000} MP decoding limit.`,
      );
      tooLarge.cause = error;
      throw tooLarge;
    }
    throw error;
  }
}

function getDetectedContentType(metadata) {
  if (metadata.format === "heif") {
    return metadata.compression === "av1" ? "image/avif" : "image/heic";
  }
  return DETECTED_IMAGE_TYPES[metadata.format] || "";
}

// Returns { data, info }; info.width is the actual output (frame) width.
async function encodeImage(input, { useWebp, grayscale, quality, width, animated }) {
  // WebP can preserve multi-frame input (GIF/animated WebP/TIFF), whereas
  // JPEG cannot. Never silently turn an animated image into a single frame.
  let pipeline = (await createSharpPipeline(input, useWebp)).rotate();

  if (width > 0) {
    pipeline = pipeline.resize({ width, fit: "inside", withoutEnlargement: true });
  }
  if (grayscale) pipeline = pipeline.grayscale();

  if (useWebp) {
    return pipeline.webp({
      quality,
      // Effort 4 is a balanced speed/size trade-off for serverless CPU budgets.
      effort: 4,
      smartSubsample: true,
      // `mixed` only affects animations. `minSize` is not used: it is
      // animation-only too and made animated encodes ~3x slower for the
      // same output size in local measurements.
      ...(animated ? { mixed: true } : {}),
    }).toBuffer({ resolveWithObject: true });
  }

  return pipeline
    // JPEG has no alpha channel; compositing transparency onto white
    // instead of letting Sharp implicitly drop the alpha avoids black or
    // broken-looking transparent regions in PNG/WebP sources.
    .flatten({ background: "#ffffff" })
    .jpeg({
      quality,
      progressive: true,
      mozjpeg: true,
      chromaSubsampling: "4:2:0",
    })
    .toBuffer({ resolveWithObject: true });
}

// Fallback widths, widest first. The ladder deliberately continues far below
// 320 px so that a small explicit max_width still has narrower sizes to try.
const FALLBACK_WIDTH_LADDER = Object.freeze([
  4096, 3072, 2048, 1600, 1280, 960, 640, 320, 240, 160, 120, 80, 64, 48, 32, 16,
]);

// Widths strictly below a requested max_width (the requested width itself is
// tried first), so max_width=100 or 320 still gets smaller sizes instead of an
// empty list. Combined with `withoutEnlargement` this never enlarges an image.
export function buildFallbackWidths(maxWidth) {
  const ceiling = maxWidth > 0 ? maxWidth : Number.POSITIVE_INFINITY;
  const widths = FALLBACK_WIDTH_LADDER.filter((width) => width < ceiling);
  if (widths.length === 0) {
    // max_width <= 16: halve down to 1 px rather than giving up.
    for (let width = Math.floor(ceiling / 2); width >= 1; width = Math.floor(width / 2)) {
      widths.push(width);
    }
  }
  return widths;
}

// The codec-specific floor (WebP 10, JPEG 20) prevents pointless near-zero-
// quality encodes but never raises a low requested quality.
export function getFallbackQuality(quality, useWebp) {
  const floor = useWebp ? 10 : 20;
  return Math.min(quality, Math.max(floor, Math.floor(quality / 2)));
}

// Encodes with the requested settings first. Only when Netlify's buffered
// response ceiling would be exceeded does it fall back, using at most
// MAX_FALLBACK_ENCODES extra encodes and never starting one after `deadline`:
//   1. one encode at the fallback quality and the same width;
//   2. width probes chosen by a size model instead of a blind search. Encoded
//      size is modelled as size ∝ width^k: k starts at 2 (pixel area) and is
//      re-fitted from the last two measurements, because downscaling also
//      removes detail and size often falls faster than area. Each probe is a
//      ladder rung strictly between the widest known fit and the narrowest
//      known miss, so the search always narrows and terminates.
// A fit at or above UNDERSHOOT_RATIO of the cap is accepted immediately;
// otherwise the widest fit found within the encode budget is returned.
export async function compressImage(
  input,
  useWebp,
  grayscale,
  quality,
  maxWidth,
  maxOutputBytes = settings.maxOutputBytes,
  { animated = false, deadline = Number.POSITIVE_INFINITY } = {},
) {
  const encode = (q, width) => encodeImage(input, { useWebp, grayscale, quality: q, width, animated });

  let result = await encode(quality, maxWidth);
  if (result.data.length <= maxOutputBytes) return result.data;

  let fallbackEncodes = 0;
  const canEncode = () => fallbackEncodes < MAX_FALLBACK_ENCODES && Date.now() < deadline;
  const encodeFallback = (q, width) => {
    fallbackEncodes += 1;
    return encode(q, width);
  };
  const budgetError = () =>
    createHttpError(504, "Image processing exceeded the request time budget.");

  const fallbackQuality = getFallbackQuality(quality, useWebp);
  if (fallbackQuality < quality) {
    if (!canEncode()) throw budgetError();
    result = await encodeFallback(fallbackQuality, maxWidth);
    if (result.data.length <= maxOutputBytes) return result.data;
  }

  const ladder = buildFallbackWidths(maxWidth);
  let missWidth = result.info.width; // narrowest width known NOT to fit
  let fitWidth = 0; // widest width known to fit
  let best = null;
  let last = { width: result.info.width, size: result.data.length };
  let previous = null;

  while (true) {
    const candidates = ladder.filter((w) => w > fitWidth && w < missWidth);
    if (candidates.length === 0) break;
    if (!canEncode()) {
      // Out of time with nothing usable is a timeout; out of encodes is a 413.
      if (!best && Date.now() >= deadline) throw budgetError();
      break;
    }

    let exponent = 2;
    if (previous && previous.width !== last.width && previous.size !== last.size) {
      const fitted = Math.log(previous.size / last.size) / Math.log(previous.width / last.width);
      if (Number.isFinite(fitted)) exponent = Math.min(Math.max(fitted, 1), 4);
    }
    const estimate = last.width * (maxOutputBytes / last.size) ** (1 / exponent) * WIDTH_ESTIMATE_SAFETY;
    const width = candidates.find((w) => w <= estimate) ?? candidates[candidates.length - 1];

    const probe = await encodeFallback(fallbackQuality, width);
    const probeWidth = Math.min(width, probe.info.width);
    if (probe.data.length <= maxOutputBytes) {
      best = probe.data;
      fitWidth = width;
      if (probe.data.length >= maxOutputBytes * UNDERSHOOT_RATIO) return best;
    } else {
      missWidth = width;
    }
    previous = last;
    last = { width: probeWidth, size: probe.data.length };
  }

  if (best) return best;
  throw createHttpError(413, "The optimized image is too large for the proxy response limit.");
}

function getOutputHeaders(contentType, originalSize, compressedSize) {
  const saved = Math.max(0, originalSize - compressedSize);
  return {
    "content-type": contentType,
    "content-length": String(compressedSize),
    "x-bh-backend": "bandwidth-proxy-2",
    "x-bh-version": PROXY_VERSION,
    "x-bh-api": API_VERSION,
    "x-bh-features": FEATURES.join(","),
    "x-bh-original-size": String(originalSize),
    "x-bh-compressed-size": String(compressedSize),
    "x-bh-bytes-saved": String(saved),
    // Legacy Bandwidth Hero telemetry headers.
    "x-original-size": String(originalSize),
    "x-compressed-size": String(compressedSize),
    "x-bytes-saved": String(saved),
  };
}

// Returns the upstream bytes untouched (animated jpeg=1 passthrough and the
// WebP never-enlarge fallback). Because the response is base64 encoded,
// untouched bytes above the safety target would exceed Netlify's 6 MB buffered
// limit and fail as an opaque gateway error, so report a clear 413 instead.
function createOriginalResponse(source, contentType, cacheHeaders) {
  const size = source.buffer.length;
  if (size > settings.maxOutputBytes) {
    throw createHttpError(413, "The source image is too large to return unmodified.");
  }
  return createBinaryResponse(
    source.buffer,
    {
      ...getSafeUpstreamHeaders(source.headers),
      ...getOutputHeaders(contentType, size, size),
    },
    cacheHeaders,
  );
}

// The untouched original can stand in for the encoded output only when it
// already looks like what was requested. The width that counts is the one the
// browser displays: EXIF orientations 5-8 swap the stored axes (the encoder
// auto-rotates, a browser rotates the original on display), so the stored
// height is the displayed width there. For multi-frame input `height` is the
// stacked total and `pageHeight` is one frame.
export function originalSatisfiesRequest(metadata, { grayscale, maxWidth }) {
  if (maxWidth > 0) {
    const rotated = Number(metadata.orientation) >= 5;
    const displayedWidth = Number(rotated ? (metadata.pageHeight ?? metadata.height) : metadata.width);
    if (!(displayedWidth > 0 && displayedWidth <= maxWidth)) return false;
  }
  if (grayscale && !(metadata.space === "b-w" || Number(metadata.channels) <= 2)) return false;
  return true;
}

export async function handler(event = {}) {
  const startedAt = Date.now();
  const method = event.httpMethod || "GET";

  if (method === "OPTIONS") {
    return createResponse(204, "", PRIVATE_CACHE_HEADERS);
  }

  if (method !== "GET") {
    return createResponse(405, "Method Not Allowed", {
      allow: "GET, OPTIONS",
      ...TEXT_ERROR_HEADERS,
    });
  }

  const query = event.queryStringParameters || {};
  const { url: rawImageUrl, legacy } = getImageUrl(event);
  if (!rawImageUrl) {
    return createResponse(200, "bandwidth-hero-proxy", {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  }

  // WebP is the default output; only an explicit jpeg=1 / jpeg=true selects JPEG.
  const useWebp = !parseBoolean(query.jpeg);
  const grayscale = parseBoolean(query.bw);
  // `??` (not `||`): quality=0 is a present value and must clamp to 1 instead
  // of falling through to the legacy alias/default like an absent parameter.
  const quality = parseInteger(query.quality ?? query.l, DEFAULT_QUALITY, 1, 100);
  const maxWidth = parseInteger(query.max_width, DEFAULT_MAX_WIDTH, 0, 8192);
  const cacheHeaders = legacy ? LEGACY_PUBLIC_CACHE_HEADERS : PUBLIC_CACHE_HEADERS;

  try {
    const source = await fetchImage(event.headers, normalizeImageUrl(rawImageUrl));
    const originalSize = source.buffer.length;
    const metadata = await probeImage(source.buffer);
    const animated = (metadata.pages || 1) > 1;
    const detectedType = getDetectedContentType(metadata);

    // JPEG has no animation model. If WebP is unavailable to the client,
    // preserve multi-frame sources instead of returning only the first frame.
    // The probe reads the bytes, so APNG and animated AVIF/HEIF served with an
    // ordinary image/png | image/avif Content-Type are detected too.
    if (!useWebp && animated) {
      return createOriginalResponse(
        source,
        detectedType || source.contentType || "application/octet-stream",
        cacheHeaders,
      );
    }

    const compressed = await compressImage(
      source.buffer,
      useWebp,
      grayscale,
      quality,
      maxWidth,
      settings.maxOutputBytes,
      { animated, deadline: startedAt + settings.requestBudgetMs },
    );

    // Never make a WebP client pay for a larger representation, but only fall
    // back to formats every Chromium browser displays; anything else stays
    // WebP. The original is only acceptable when it already satisfies the
    // request: not wider than max_width, and already grayscale when bw=1.
    // Explicit jpeg=1 is a format request and is always honored for static
    // images.
    if (
      useWebp &&
      compressed.length >= originalSize &&
      BROWSER_SAFE_TYPES.has(detectedType) &&
      originalSatisfiesRequest(metadata, { grayscale, maxWidth })
    ) {
      return createOriginalResponse(source, detectedType, cacheHeaders);
    }

    return createBinaryResponse(
      compressed,
      getOutputHeaders(useWebp ? "image/webp" : "image/jpeg", originalSize, compressed.length),
      cacheHeaders,
    );
  } catch (error) {
    // Sharp versions can report a processing timeout by name or by message;
    // classify both forms as 504 instead of a generic 500.
    const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : isTimeoutError(error) ? 504 : 500;
    // Client-side and upstream 4xx outcomes (invalid URL, private host, 404...)
    // are expected traffic; only server-side failures are logged.
    if (statusCode >= 500) {
      console.error("Image proxy error:", error?.message || error, error?.cause || "");
    }
    return createResponse(statusCode, error?.message || "Image processing failed.", TEXT_ERROR_HEADERS);
  }
}
