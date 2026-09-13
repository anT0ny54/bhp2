# Changelog

## 2.2.5
- **Security fix**: closed a DNS-rebinding (TOCTOU) gap in outbound image fetches. Previously, `resolveAndValidateRemoteUrl` checked DNS answers up front, but the actual `fetch()` call re-resolved the hostname itself at connect time (Node's built-in `fetch` ignores the legacy `http(s).Agent` option), so a low-TTL DNS answer could rebind to a private/internal address between the check and the connection. Outbound requests — including each redirect hop — are now pinned to the exact addresses that were just validated, using an `undici` Agent with a custom DNS resolver.
- Adds `undici` as a direct dependency (justified exception to the project's no-new-dependency preference — see `CONTRIBUTING.md`); it's the library that already powers Node's `fetch()`, and there's no way to pin a connection using Node's standard library alone.
- Added tests covering the new pinning behavior and confirming it actually gates the outbound request (not just present as unused code).
- No change to query parameters, response headers, or client-visible behavior.

## 2.2.4
- Removed unused legacy modules (`util/fetch.js`, `util/compress.js`, `util/pick.js`, `util/shouldCompress.js`) left over from an earlier architecture; all request handling and image compression is implemented directly in `functions/index.js` and none of these files were imported anywhere.
- Removed an unused, duplicate `PRIVATE_HOSTNAMES` constant in `functions/index.js` (the real check lives in `util/validate.js` via `isPrivateHost`).
- Synced `/api/health`'s reported version with the actual package/proxy version (it had drifted to 2.2.2 while the rest of the app moved to 2.2.3).
- Fixed a stale `X-BH-Version` value in `docs/backend-contract.md`'s example response.
- No behavior, query parameters, or response headers changed; Bandwidth Guardian/Bandwidth Hero compatibility is unaffected.

## 2.2.3
- Fixed the no-savings fallback so original bytes keep their real media type.
- Added format detection only on the rare missing-Content-Type fallback path.
- Kept Bandwidth Guardian/Bandwidth Hero query and telemetry compatibility.

## 2.2.2

- Lazy-load Sharp so the Bandwidth Hero compatibility handshake does not fail when the native image module cannot initialize.
- Add Sharp runtime diagnostics to `/api/health`.
- Explicitly include Linux x64/arm64 Sharp runtime packages for Netlify Functions.
- Return a clear 503 when the image processor cannot initialize.
- Keep the existing Bandwidth Guardian API contract unchanged.


## 2.2.1
- Updated dependency metadata to the current locked Sharp/Netlify CLI line.
- Fixed case-insensitive request-header handling and DNS lookup timeout handling.
- Preserved animated images when WebP is available instead of silently collapsing them to one frame.

## 2.2.0
- Redesigned the public diagnostics/setup page for mobile and desktop.
- Moved page CSS and JavaScript out of `index.html` for cleaner caching and maintenance.
- Added one-tap proxy URL copying.
- Improved diagnostics with API version, latency, output type, savings and cache reporting.
- Preserved the existing `/api/index` and `/api/health` behavior and Netlify configuration.
- Kept the extension-compatible BHP2 query parameters and telemetry headers unchanged.
