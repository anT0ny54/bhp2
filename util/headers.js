// Single source of truth for the CORS/security headers shared by every
// /api/* response, and for the response-object shape both functions return.
// netlify.toml deliberately carries NO hand-copied [[headers]] block for
// /api/* — that copy used to drift from the runtime headers. Static assets get
// their Cache-Control from netlify.toml, not from here.
export const BASE_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Content-Type",
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
