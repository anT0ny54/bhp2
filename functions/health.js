import { PROXY_VERSION, API_VERSION, FEATURES } from "../util/version.js";
import { CORS_HEADERS, SECURITY_HEADERS } from "../util/headers.js";

// Same response-building pattern as functions/index.js: shared CORS and
// security headers come from util/headers.js exactly once, so a future header
// addition cannot be missed in one handler.
const BASE_HEADERS = {
  ...CORS_HEADERS,
  ...SECURITY_HEADERS,
};

const HEALTH_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function createResponse(statusCode, body = "", headers = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...headers },
    body,
  };
}

export async function handler(event = {}) {
  const method = event.httpMethod || "GET";
  if (method === "OPTIONS") {
    return createResponse(204, "", { "cache-control": "no-store" });
  }
  if (method !== "GET") {
    // Error responses are plain text per docs/backend-contract.md, matching
    // the main proxy handler instead of returning a JSON body here.
    return createResponse(405, "Method Not Allowed", {
      allow: "GET, OPTIONS",
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
  }

  let sharpStatus = { available: false };
  try {
    const module = await import("sharp");
    const sharp = module.default || module;
    sharpStatus = {
      available: true,
      version: sharp.versions?.sharp || "unknown",
      libvips: sharp.versions?.vips || "unknown",
    };
  } catch (error) {
    sharpStatus = {
      available: false,
      error: error?.message || "Unable to load Sharp",
    };
  }

  return createResponse(
    200,
    JSON.stringify({
      status: "ok",
      service: "bandwidth-hero-proxy",
      version: PROXY_VERSION,
      api: Number(API_VERSION),
      sharp: sharpStatus,
      features: FEATURES,
    }),
    HEALTH_HEADERS,
  );
}
