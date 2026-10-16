// Single source of truth for the CORS/security headers shared by every
// /api/* response, and for the response-object shape both functions return.
// netlify.toml deliberately carries NO hand-copied [[headers]] block for
// /api/* — that copy used to drift from the runtime headers. Static assets get
// their Cache-Control from netlify.toml, not from here.

// Cross-origin callers can only read response headers outside the CORS-safelisted
// set when they are listed in Access-Control-Expose-Headers. These are the
// telemetry headers set by getOutputHeaders() in functions/index.js; a test in
// tests/integration.test.js fails if the two lists drift apart.
const EXPOSED_HEADERS = [
  "x-bh-backend",
  "x-bh-version",
  "x-bh-api",
  "x-bh-features",
  "x-bh-original-size",
  "x-bh-compressed-size",
  "x-bh-bytes-saved",
  "x-original-size",
  "x-compressed-size",
  "x-bytes-saved",
].join(", ");

export const BASE_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "access-control-expose-headers": EXPOSED_HEADERS,
  "access-control-max-age": "86400",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

export function createResponse(statusCode, body = "", headers = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...headers },
    body,
  };
}
