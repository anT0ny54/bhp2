// Shared response header fragments for the function handlers.
//
// functions/index.js and functions/health.js used to hand-maintain their own
// copies of these headers. The version-string drift that bit this project
// twice (see CHANGELOG 2.2.4 and 2.2.6) was the same duplication pattern, so
// the common headers now live in exactly one place and both handlers import
// them. Handler-specific headers (Content-Type, Cache-Control, telemetry)
// still belong to each handler.
export const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
});

export const SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});
