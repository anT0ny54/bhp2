import http from "node:http";
import https from "node:https";

import {
  INVALID_URL_ERROR,
  PRIVATE_HOST_ERROR,
  parseHttpUrl,
  isPrivateHost,
  resolveAndValidateRemoteUrl,
  createPinnedLookup,
} from "../util/validate.js";
import { PROXY_VERSION, API_VERSION, FEATURES } from "../util/version.js";
import { CORS_HEADERS, SECURITY_HEADERS } from "../util/headers.js";

const DETECTED_IMAGE_TYPES = Object.freeze({
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
  avif: "image/avif",
  heif: "image/heif",
  heic: "image/heic",
  jxl: "image/jxl",
});

const DEFAULT_QUALITY = 60;
const DEFAULT_MAX_WIDTH = 0;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Conservative default for serverless memory headroom; raise only after load testing.
const MAX_INPUT_PIXELS = 24_000_000;
// Netlify buffered Functions have a 6 MB response limit; Lambda-style
// binary responses are base64 encoded, so keep a safety margin below it.
const MAX_FUNCTION_OUTPUT_BYTES = 4_300_000;

// Browser cache is deliberately short-lived because extension settings are
// encoded into the URL. Netlify's CDN keeps the expensive compressed result.
const PUBLIC_CACHE_HEADERS = {
  "cache-control": "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800",
  "netlify-cdn-cache-control": "public, durable, s-maxage=2592000, stale-while-revalidate=604800",
  "netlify-vary": "query=url|quality|bw|jpeg|max_width|l",
};

const PRIVATE_CACHE_HEADERS = {
  "cache-control": "private, no-store",
};

const BASE_HEADERS = {
  ...CORS_HEADERS,
  ...SECURITY_HEADERS,
};

// Runtime limits live in one frozen object so the integration tests can shrink
// them (a 500 ms deadline instead of 8 s, a 2 KB output cap instead of 4.3 MB)
// without touching the production defaults or exposing them to requests.
// Nothing in the request path can modify this; only configureForTests() can.
const DEFAULT_SETTINGS = Object.freeze({
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxOutputBytes: MAX_FUNCTION_OUTPUT_BYTES,
  resolveRemoteUrl: resolveAndValidateRemoteUrl,
});
let settings = DEFAULT_SETTINGS;

export function configureForTests(overrides = {}) {
  settings = Object.freeze({ ...DEFAULT_SETTINGS, ...overrides });
}
export function resetConfigForTests() {
  settings = DEFAULT_SETTINGS;
}

let sharpPromise;

async function getSharp() {
  if (!sharpPromise) {
    sharpPromise = import("sharp").then((module) => {
      const sharp = module.default || module;
      // Favor predictable memory use on small serverless instances. This limits
      // libvips threads per image; it does not limit concurrent invocations.
      sharp.concurrency(1);
      return sharp;
    });
  }
  try {
    return await sharpPromise;
  } catch (error) {
    sharpPromise = undefined;
    const wrapped = new Error("Image processor is unavailable on the Netlify runtime.");
    wrapped.statusCode = 503;
    wrapped.cause = error;
    throw wrapped;
  }
}

// user-agent and accept-language are handled with defaults in
// buildUpstreamHeaders, so only the pass-through-only headers are listed here.
const FORWARDED_REQUEST_HEADERS = ["cookie", "dnt", "referer"];

function createResponse(statusCode, body = "", headers = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...headers },
    body,
  };
}

function createBinaryResponse(buffer, headers = {}, cacheHeaders = PUBLIC_CACHE_HEADERS) {
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

function getQueryParameters(event) {
  return event?.queryStringParameters || {};
}

// `url` is normally a single query-string value, but this also has to cope
// with a legacy-client bug: extensions that build the proxy URL without
// encodeURIComponent()-ing the upstream image URL will leak that upstream
// URL's own "?a=b&c=d" query params into the *outer* query string. Netlify
// then parses those as repeated `url` params (an array) or, in some
// gateways, `value` itself arrives pre-joined as one string. Rejoining with
// "&url=" reconstructs the original nested query string instead of only
// keeping the first fragment before the unencoded "&". The JSON.parse branch
// handles the same array shape when it arrives JSON-encoded instead.
function getImageUrl(value) {
  if (!value) return "";

  if (Array.isArray(value)) return value.join("&url=");

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.join("&url=");
    if (typeof parsed === "string") return parsed;
    // Valid JSON that is neither a string nor an array (number, boolean,
    // null) can never be an HTTP URL, but falling through to String(value)
    // keeps the original text so parseHttpUrl rejects it with a proper 400
    // instead of this branch silently inventing a different value.
  } catch {
    // Normal query-string URL.
  }

  return String(value);
}

function normalizeImageUrl(value) {
  const raw = getImageUrl(value)
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

function parseInteger(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function parseBoolean(value) {
  return value === "1" || value === "true";
}

// Client-supplied header names arrive with whatever casing the caller used.
// Normalizing them once here means both the cookie check and the upstream
// header builder below read from the same lower-cased view instead of each
// re-scanning and re-lowercasing event.headers independently.
function getNormalizedHeaders(event) {
  const input = event?.headers || {};
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [String(name).toLowerCase(), value]),
  );
}

function buildUpstreamHeaders(normalized) {
  const headers = {
    accept: normalized.accept || "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "accept-encoding": "identity",
    "user-agent": normalized["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "accept-language": normalized["accept-language"] || "en-US,en;q=0.9",
  };

  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (normalized[name]) headers[name] = normalized[name];
  }

  return headers;
}

function hasCredentials(normalized) {
  return Boolean(normalized.cookie);
}

// Node's native http/https request supports a custom `lookup` in its options
// object, so the socket can be pinned to the DNS-validated addresses directly
// through a first-class, documented API — no third-party dispatcher involved.
// This replaces the previous undici Agent approach, which failed in
// production with opaque undici "fetch failed" connector errors on some
// Netlify runtimes (npm-undici vs. Node's built-in fetch interop under
// esbuild bundling). The DNS pinning guarantees are identical: the pinned
// lookup only ever answers with the addresses that
// resolveAndValidateRemoteUrl already checked.
function requestPinned(urlString, upstreamHeaders, lookup, signal, socketTimeoutMs) {
  return new Promise((resolve, reject) => {
    // Never initiate a new upstream request once the shared deadline has fired.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const target = new URL(urlString);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.get(target, {
      lookup,
      headers: upstreamHeaders,
      // Fresh socket per hop; nothing pooled, nothing to leak or keep warm.
      agent: false,
    }, (response) => {
      resolve(response);
    });

    request.on("error", reject);

    // Socket inactivity timeout; resets on activity, so a slow-drip upstream
    // cannot stall forever even between bytes.
    request.setTimeout(socketTimeoutMs, () => {
      request.destroy(Object.assign(
        new Error("Upstream socket timed out."),
        { name: "AbortError" },
      ));
    });

    // One deadline covers every hop AND the body download.
    const onAbort = () => request.destroy(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

export async function fetchImage(normalizedHeaders, initialUrl) {
  const { fetchTimeoutMs, maxImageBytes, resolveRemoteUrl } = settings;
  let currentUrl = initialUrl;
  // Forwarded request headers don't change across hops, except that
  // credentials are dropped when a redirect leaves the original origin.
  let upstreamHeaders = buildUpstreamHeaders(normalizedHeaders);
  const controller = new AbortController();
  // One deadline covers every hop AND the body download, so a slow-drip
  // upstream can't outlive the timeout once its headers have arrived.
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      // The deadline is checked before every hop, and the DNS step observes the
      // same signal, so a stalled resolver cannot outlive the 8 s budget or let
      // a later hop start after it.
      controller.signal.throwIfAborted();
      const validation = await resolveRemoteUrl(currentUrl, { signal: controller.signal });
      if (!validation.valid) {
        const error = new Error(validation.error);
        error.statusCode = validation.statusCode || 403;
        throw error;
      }

      controller.signal.throwIfAborted();
      const upstream = await requestPinned(
        validation.url,
        upstreamHeaders,
        createPinnedLookup(validation.addresses),
        controller.signal,
        fetchTimeoutMs,
      );

      const location = upstream.headers.location;
      const status = upstream.statusCode || 0;
      if (status >= 300 && status < 400 && location) {
        // agent:false, so destroying the response closes the socket.
        upstream.destroy();
        if (redirect === MAX_REDIRECTS) {
          const error = new Error("Too many upstream redirects.");
          error.statusCode = 508;
          throw error;
        }
        let next;
        try {
          next = new URL(location, validation.url);
        } catch {
          const error = new Error("Upstream sent an invalid redirect location.");
          error.statusCode = 502;
          throw error;
        }
        if (next.origin !== new URL(validation.url).origin) {
          const { cookie, referer, ...withoutCredentials } = upstreamHeaders;
          upstreamHeaders = withoutCredentials;
        }
        currentUrl = next.toString();
        continue;
      }

      if (status < 200 || status >= 300) {
        upstream.destroy();
        const error = new Error(`Upstream image request failed with status ${status}.`);
        error.statusCode = status >= 400 && status <= 599 ? status : 502;
        throw error;
      }

      const contentType = String(upstream.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();

      // Keep compatibility with CDNs that omit Content-Type. Sharp will validate
      // the actual bytes below. Explicit non-image responses are rejected early.
      if (contentType && !contentType.startsWith("image/")) {
        upstream.destroy();
        const error = new Error(`Upstream returned a non-image response (${contentType}).`);
        error.statusCode = 415;
        throw error;
      }

      return {
        buffer: await readLimitedBody(upstream, maxImageBytes),
        contentType,
        headers: upstream.headers,
      };
    }
  } catch (error) {
    // When the shared deadline fires mid-body, Node surfaces the destroyed
    // socket as a plain ECONNRESET ("aborted") rather than an AbortError, so
    // the controller's own state is the reliable signal for a timeout.
    if (error?.name === "AbortError" ||
        (controller.signal.aborted && !Number.isInteger(error?.statusCode))) {
      throw createHttpError(504, "Upstream image request timed out.");
    }
    // Connector-level failures (ECONNREFUSED, ENETUNREACH, TLS errors, DNS
    // rebinding caught late) mean the upstream could not be reached at all.
    // Report them as gateway errors with the underlying code so a broken
    // deployment is diagnosable from the response body and the logs.
    if (error && !Number.isInteger(error.statusCode)) {
      const code = error.code ? ` [${error.code}]` : "";
      const gateway = new Error(`Upstream connection failed${code}.`);
      gateway.statusCode = 502;
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

// Every decode uses the same safety options; building the instance in one
// place keeps them from drifting apart (animated input is only ever enabled
// for the WebP pipeline and metadata probes, never for JPEG output).
async function createSharpPipeline(input, animated) {
  const sharp = await getSharp();
  return sharp(input, {
    animated,
    failOn: "warning",
    limitInputPixels: MAX_INPUT_PIXELS,
  });
}

async function encodeImage(input, useWebp, grayscale, quality, maxWidth) {
  // WebP can preserve multi-frame input (GIF/animated WebP/TIFF), whereas
  // JPEG cannot. Never silently turn an animated image into a single frame.
  let pipeline = (await createSharpPipeline(input, useWebp)).rotate();

  if (maxWidth > 0) {
    pipeline = pipeline.resize({ width: maxWidth, fit: "inside", withoutEnlargement: true, fastShrinkOnLoad: true });
  }
  if (grayscale) pipeline = pipeline.grayscale();

  return useWebp
    ? pipeline.webp({
        quality,
        // Effort 4 is a balanced speed/size trade-off for serverless CPU budgets.
        effort: 4,
        smartSubsample: true,
        minSize: true,
        mixed: true,
      }).toBuffer()
    : pipeline.jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: "4:2:0",
      }).toBuffer();
}

// Fallback widths, widest first. The ladder deliberately continues far below
// 320 px so that a small explicit max_width still has narrower sizes to try.
const FALLBACK_WIDTH_LADDER = Object.freeze([
  4096, 3072, 2048, 1600, 1280, 960, 640, 320, 240, 160, 120, 80, 64, 48, 32, 16,
]);

// Widths to try, in order, once lowering quality alone was not enough. Only
// widths strictly below a requested max_width are used (the requested width
// itself was already tried by the quality loop), so a request such as
// max_width=100 or 320 still gets smaller sizes instead of an empty list.
// Combined with `withoutEnlargement` at encode time this never enlarges an image.
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

export async function compressImage(
  input,
  useWebp,
  grayscale,
  quality,
  maxWidth,
  maxOutputBytes = settings.maxOutputBytes,
) {
  let output = await encodeImage(input, useWebp, grayscale, quality, maxWidth);
  if (output.length <= maxOutputBytes) return output;

  // Keep the requested settings as the first choice. Only enter this fallback
  // when Netlify's buffered-response ceiling would otherwise be exceeded.
  for (let q = quality - 10; q >= (useWebp ? 10 : 20); q -= 10) {
    output = await encodeImage(input, useWebp, grayscale, q, maxWidth);
    if (output.length <= maxOutputBytes) return output;
  }

  // If quality alone is insufficient, progressively reduce dimensions. This
  // protects large images from producing a base64 response that Netlify will
  // reject while preserving the extension's normal max_width behaviour.
  for (const width of buildFallbackWidths(maxWidth)) {
    output = await encodeImage(input, useWebp, grayscale, useWebp ? 30 : 45, width);
    if (output.length <= maxOutputBytes) return output;
  }

  const error = new Error("The optimized image is too large for the proxy response limit.");
  error.statusCode = 413;
  throw error;
}

function getOutputHeaders(contentType, originalSize, compressedSize) {
  const saved = Math.max(0, originalSize - compressedSize);
  return {
    "content-type": contentType,
    "content-length": String(compressedSize),
    "content-encoding": "identity",
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

async function getDetectedImageContentType(buffer) {
  try {
    const metadata = await (await createSharpPipeline(buffer, true)).metadata();
    return DETECTED_IMAGE_TYPES[metadata.format] || "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}

// Returns the upstream bytes untouched. Both the animated-JPEG passthrough and
// the never-enlarge fallback use this. Because the response is base64 encoded,
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

export async function handler(event = {}) {
  const method = event.httpMethod || "GET";

  if (method === "OPTIONS") {
    return createResponse(204, "", PRIVATE_CACHE_HEADERS);
  }

  if (method !== "GET") {
    return createResponse(405, "Method Not Allowed", {
      allow: "GET, OPTIONS",
      "content-type": "text/plain; charset=utf-8",
      ...PRIVATE_CACHE_HEADERS,
    });
  }

  const query = getQueryParameters(event);
  if (!query.url) {
    return createResponse(200, "bandwidth-hero-proxy", {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  }

  const imageUrl = normalizeImageUrl(query.url);
  const initial = parseHttpUrl(imageUrl);
  if (!initial) {
    return createResponse(400, INVALID_URL_ERROR, {
      "content-type": "text/plain; charset=utf-8",
      ...PRIVATE_CACHE_HEADERS,
    });
  }

  if (isPrivateHost(initial.hostname)) {
    return createResponse(400, PRIVATE_HOST_ERROR, {
      "content-type": "text/plain; charset=utf-8",
      ...PRIVATE_CACHE_HEADERS,
    });
  }

  const useWebp = query.jpeg !== "1";
  const grayscale = parseBoolean(query.bw);
  const quality = parseInteger(query.quality || query.l, DEFAULT_QUALITY, 1, 100);
  const maxWidth = parseInteger(query.max_width, DEFAULT_MAX_WIDTH, 0, 8192);
  const normalizedHeaders = getNormalizedHeaders(event);
  const cacheHeaders = hasCredentials(normalizedHeaders) ? PRIVATE_CACHE_HEADERS : PUBLIC_CACHE_HEADERS;

  try {
    const source = await fetchImage(normalizedHeaders, initial.toString());
    const originalSize = source.buffer.length;

    // JPEG has no animation model. If WebP is unavailable to the client,
    // preserve multi-frame sources instead of returning only the first frame.
    // A missing Content-Type is probed too, so an animated GIF from a CDN
    // that omits the header is not silently flattened to its first frame.
    if (!useWebp && (!source.contentType || /^image\/(gif|webp|tiff)$/i.test(source.contentType))) {
      try {
        const metadata = await (await createSharpPipeline(source.buffer, true)).metadata();
        if ((metadata.pages || 1) > 1) {
          const type = source.contentType || DETECTED_IMAGE_TYPES[metadata.format] || "application/octet-stream";
          return createOriginalResponse(source, type, cacheHeaders);
        }
      } catch (error) {
        // An undecodable body with a declared image type is reported by the
        // compression step below; only a 503/413-style HTTP error is final here.
        if (Number.isInteger(error?.statusCode)) throw error;
      }
    }

    const compressed = await compressImage(
      source.buffer,
      useWebp,
      grayscale,
      quality,
      maxWidth,
    );

    if (compressed.length >= originalSize) {
      // Never make a client pay for a larger representation. Preserve the
      // original bytes AND a real media type. Some CDNs omit Content-Type, so
      // detect the format only on this uncommon fallback path.
      const originalContentType =
        source.contentType || await getDetectedImageContentType(source.buffer);
      return createOriginalResponse(source, originalContentType, cacheHeaders);
    }

    const outputType = useWebp ? "image/webp" : "image/jpeg";
    return createBinaryResponse(
      compressed,
      getOutputHeaders(outputType, originalSize, compressed.length),
      cacheHeaders,
    );
  } catch (error) {
    console.error("Image proxy error:", error?.message || error, error?.cause || "");
    const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : error?.name === "AbortError" ? 504 : 500;
    const message = error?.message || "Image processing failed.";
    return createResponse(statusCode, message, {
      "content-type": "text/plain; charset=utf-8",
      ...PRIVATE_CACHE_HEADERS,
    });
  }
}
