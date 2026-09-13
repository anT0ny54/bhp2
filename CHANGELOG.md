# Changelog

## 2.2.7
- **Fixed recurring version drift**: `functions/health.js` and `package.json` had fallen back out of sync with the actual proxy version in `functions/index.js` (2.2.5 vs. 2.2.6) — the same class of bug already fixed once before in 2.2.4. Introduced `util/version.js` as the single source of truth for `PROXY_VERSION`/`API_VERSION`/`FEATURES`, imported by both functions, so the two files can no longer drift independently. Added a regression test (`keeps the proxy version in sync...`) that fails the build if `package.json`, `/api/health`, and the `X-BH-Version` response header ever disagree again.
- Fixed stale documentation in `docs/backend-contract.md` left over from the 2.2.6 cache/version changes: the example `Cache-Control` header still showed the pre-2.2.6 `max-age=3600`, and the example `X-BH-Version` still showed `2.2.5`.
- Removed redundant work in the request path: upstream request headers were being rebuilt from `event.headers` on every redirect hop even though they never change per-hop; cookie detection and header normalization each re-scanned and re-lowercased `event.headers` independently. Both now share one normalization pass computed once per invocation.
- Fixed test fragility: 3 tests asserted exact compressed-byte-size relationships for trivial synthetic images (e.g. "a 1x1 PNG must compress *larger* as WebP") that depend on the installed libvips/mozjpeg minor version rather than the actual fallback logic being tested. They now compare against JPEG's fixed container overhead (which robustly exceeds a hand-crafted tiny PNG regardless of encoder version) and a deterministic photo-like fixture (for the "JPEG legitimately compresses smaller" case), instead of a flat solid color, which is a worst case for lossy formats.
- No changes to query parameters, response headers, or client-visible behavior — Bandwidth Guardian/Bandwidth Hero MV3 compatibility is unaffected.

## 2.2.6
- Increased WebP encoder effort from 4 to 6 for smaller output.
- Enabled animated WebP `minSize`/`mixed` encoding to reduce animation keyframe overhead.
- Canonicalized away HTTP URL fragments to improve cache reuse.
- Increased public browser cache from 1 hour to 24 hours and edge cache from 7 days to 30 days.
- Reduced the buffered binary safety target from 4.4 MB to 4.3 MB.


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
