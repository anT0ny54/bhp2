import sharp from "sharp";

import {
  INVALID_URL_ERROR,
  PRIVATE_HOST_ERROR,
  parseHttpUrl,
  isPrivateHost,
  resolveAndValidateRemoteUrl,
} from "../util/validate.js";

const DEFAULT_QUALITY = 40;
const DEFAULT_MAX_WIDTH = 0;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
// Netlify buffered Functions have a 6 MB response limit; Lambda-style
// binary responses are base64 encoded, so keep a safety margin below it.
const MAX_FUNCTION_OUTPUT_BYTES = 4_400_000;
const PROXY_VERSION = "2.1.0";
const API_VERSION = "1";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

// Browser cache is deliberately short-lived because extension settings are
// encoded into the URL. Netlify's CDN keeps the expensive compressed result.
const PUBLIC_CACHE_HEADERS = {
  "cache-control": "public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400",
  "netlify-cdn-cache-control": "public, durable, s-maxage=604800, stale-while-revalidate=86400",
  "netlify-vary": "query=url|quality|bw|jpeg|max_width|l",
};

const PRIVATE_CACHE_HEADERS = {
  "cache-control": "private, no-store",
};

const BASE_HEADERS = {
  ...CORS_HEADERS,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "local",
  "ip6-localhost",
  "ip6-loopback",
]);

const FORWARDED_REQUEST_HEADERS = [
  ["cookie", "cookie"],
  ["dnt", "dnt"],
  ["referer", "referer"],
  ["user-agent", "user-agent"],
  ["accept-language", "accept-language"],
];

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

function getImageUrl(value) {
  if (!value) return "";

  if (Array.isArray(value)) return value.join("&url=");

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.join("&url=");
    if (typeof parsed === "string") return parsed;
  } catch {
    // Normal query-string URL.
  }

  return String(value);
}

function normalizeImageUrl(value) {
  return getImageUrl(value)
    .trim()
    .replace(/^http:\/\/1\.1\.\d+\.\d+\/bmi\/(https?:\/\/)?/i, "http://");
}

function parseInteger(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function parseBoolean(value) {
  return value === "1" || value === "true";
}

function getRequestHeaders(event) {
  const input = event?.headers || {};
  const headers = {
    accept: input.accept || "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "accept-encoding": "identity",
    "user-agent": input["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "accept-language": input["accept-language"] || "en-US,en;q=0.9",
  };

  for (const [source, target] of FORWARDED_REQUEST_HEADERS) {
    if (input[source]) headers[target] = input[source];
  }

  return headers;
}

function hasCredentials(event) {
  return Boolean(event?.headers?.cookie);
}

async function fetchWithDeadline(url, options, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);

  try {
    return await fetch(url, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedBody(response) {
  const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    const error = new Error("The source image is too large.");
    error.statusCode = 413;
    throw error;
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      const error = new Error("The source image is too large.");
      error.statusCode = 413;
      throw error;
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        const error = new Error("The source image is too large.");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchImage(event, initialUrl) {
  let currentUrl = initialUrl;
  const deadline = Date.now() + FETCH_TIMEOUT_MS;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const validation = await resolveAndValidateRemoteUrl(currentUrl);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.statusCode = validation.statusCode || 403;
      throw error;
    }

    let upstream;
    try {
      upstream = await fetchWithDeadline(validation.url, {
        method: "GET",
        headers: getRequestHeaders(event),
      }, deadline);
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("Upstream image request timed out.");
        timeout.statusCode = 504;
        throw timeout;
      }
      throw error;
    }

    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      if (redirect === MAX_REDIRECTS) {
        const error = new Error("Too many upstream redirects.");
        error.statusCode = 508;
        throw error;
      }
      currentUrl = new URL(location, validation.url).toString();
      continue;
    }

    if (!upstream.ok) {
      const error = new Error(`Upstream image request failed with status ${upstream.status}.`);
      error.statusCode = upstream.status >= 400 ? upstream.status : 502;
      throw error;
    }

    const contentType = (upstream.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();

    // Keep compatibility with CDNs that omit Content-Type. Sharp will validate
    // the actual bytes below. Explicit non-image responses are rejected early.
    if (contentType && !contentType.startsWith("image/")) {
      const error = new Error(`Upstream returned a non-image response (${contentType}).`);
      error.statusCode = 415;
      throw error;
    }

    return {
      buffer: await readLimitedBody(upstream),
      contentType,
      headers: upstream.headers,
    };
  }

  const error = new Error("Unable to fetch image.");
  error.statusCode = 502;
  throw error;
}

function getSafeUpstreamHeaders(headers) {
  const output = {};
  for (const name of ["etag", "last-modified", "expires"]) {
    const value = headers.get(name);
    if (value) output[name] = value;
  }
  return output;
}

async function encodeImage(input, useWebp, grayscale, quality, maxWidth) {
  let pipeline = sharp(input, {
    animated: false,
    failOn: "none",
    limitInputPixels: MAX_INPUT_PIXELS,
  }).rotate();

  if (maxWidth > 0) {
    pipeline = pipeline.resize({ width: maxWidth, fit: "inside", withoutEnlargement: true, fastShrinkOnLoad: true });
  }
  if (grayscale) pipeline = pipeline.grayscale();

  return useWebp
    ? pipeline.webp({ quality, effort: 4, smartSubsample: true }).toBuffer()
    : pipeline.jpeg({ quality, progressive: true, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer();
}

async function compressImage(input, useWebp, grayscale, quality, maxWidth) {
  let output = await encodeImage(input, useWebp, grayscale, quality, maxWidth);
  if (output.length <= MAX_FUNCTION_OUTPUT_BYTES) return output;

  // Keep the requested settings as the first choice. Only enter this fallback
  // when Netlify's buffered-response ceiling would otherwise be exceeded.
  for (let q = quality - 10; q >= (useWebp ? 10 : 20); q -= 10) {
    output = await encodeImage(input, useWebp, grayscale, q, maxWidth);
    if (output.length <= MAX_FUNCTION_OUTPUT_BYTES) return output;
  }

  // If quality alone is insufficient, progressively reduce dimensions. This
  // protects large images from producing a base64 response that Netlify will
  // reject while preserving the extension's normal max_width behaviour.
  const requestedWidth = maxWidth > 0 ? maxWidth : 4096;
  for (const width of [requestedWidth, 3072, 2048, 1600, 1280]) {
    if (width <= 0 || (maxWidth > 0 && width >= maxWidth)) continue;
    output = await encodeImage(input, useWebp, grayscale, useWebp ? 30 : 45, width);
    if (output.length <= MAX_FUNCTION_OUTPUT_BYTES) return output;
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
    "x-bh-features": "webp,grayscale,maxwidth,stats",
    "x-bh-original-size": String(originalSize),
    "x-bh-compressed-size": String(compressedSize),
    "x-bh-bytes-saved": String(saved),
    // Legacy Bandwidth Hero telemetry headers.
    "x-original-size": String(originalSize),
    "x-compressed-size": String(compressedSize),
    "x-bytes-saved": String(saved),
  };
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
  const quality = parseInteger(query.quality ?? query.l, DEFAULT_QUALITY, 1, 100);
  const maxWidth = parseInteger(query.max_width, DEFAULT_MAX_WIDTH, 0, 8192);
  const cacheHeaders = hasCredentials(event) ? PRIVATE_CACHE_HEADERS : PUBLIC_CACHE_HEADERS;

  try {
    const source = await fetchImage(event, initial.toString());
    const originalSize = source.buffer.length;

    const compressed = await compressImage(
      source.buffer,
      useWebp,
      grayscale,
      quality,
      maxWidth,
    );

    if (compressed.length >= originalSize) {
      // Never make a client pay for a larger representation. Preserve the
      // original bytes and original media type when compression is a loss.
      return createBinaryResponse(
        source.buffer,
        {
          ...getSafeUpstreamHeaders(source.headers),
          ...getOutputHeaders(source.contentType || "image/*", originalSize, originalSize),
        },
        cacheHeaders,
      );
    }

    const outputType = useWebp ? "image/webp" : "image/jpeg";
    return createBinaryResponse(
      compressed,
      getOutputHeaders(outputType, originalSize, compressed.length),
      cacheHeaders,
    );
  } catch (error) {
    console.error("Image proxy error:", error);
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

