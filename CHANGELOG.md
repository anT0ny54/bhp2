# Changelog

## 2.1.0 — Netlify compatibility and optimization build

- Preserved Bandwidth Guardian and Bandwidth Hero MV3 API parameters and telemetry.
- Restored legacy request/response compatibility surfaces from proxy2.
- Added DNS-aware SSRF validation on every redirect hop.
- Added IPv4-mapped IPv6, link-local, CGNAT, multicast and unique-local checks.
- Changed upstream timeout to a single wall-clock deadline across redirects.
- Added bounded upstream response reads and Sharp pixel limits.
- Added CDN/browser caching headers with query-aware Netlify cache variation.
- Kept cookie-bearing requests private and uncached.
- Improved Sharp/Netlify native dependency packaging.
- Removed the `NPM_FLAGS=--omit=optional` deployment hazard.
- Added adaptive quality/dimension fallback for Netlify's buffered response limit.
- Kept WebP as the default and JPEG as an explicit compatibility option.
