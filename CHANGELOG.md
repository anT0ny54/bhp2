# Changelog

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
