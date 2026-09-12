# Changelog

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
