# Changelog

## 2.2.8
- **Security**: bumped `undici` 7.26.0 → 7.29.1. The pinned 7.26.0 predated fixes for several disclosed issues, including a cache-interceptor bug that could let one caller's cached response (and cookies) leak to another (GHSA-2jfj-6hjv-fm6j) and an unbounded-decompression memory issue (GHSA-3xpg-4rpp-hhhm). This proxy doesn't use the cache interceptor or WebSocket client that most of these affect, but there's no reason to stay on a version with known, patched issues in a dependency that terminates every outbound image fetch. Stayed on the 7.x line rather than jumping to 8.x: undici 8 raises the minimum Node.js version to 22.19.0+ (satisfied here) but also restructures the handler API and enables HTTP/2-by-default when a server negotiates it via ALPN — a real behavior change for the redirect/fetch path in `functions/index.js` that deserves its own reviewed, tested pass rather than riding along with a docs/dependency cleanup.
- Bumped the `netlify-cli` dev dependency 27.5.1 → 27.8.0 (local `netlify dev` only; not part of the deployed function bundle).
- **Fixed a validation gap**: `npm run validate` (`node --check ...`) covered `functions/index.js`, `functions/health.js`, and `util/validate.js`, but not `util/version.js` — the shared version/feature-metadata module both function files import, added in 2.2.7. A syntax error there would have passed `validate` and only surfaced once the test suite happened to import it. Added it to the validate command.
- Documented the previously-unexplained array/JSON-rejoin branch in `functions/index.js`'s `getImageUrl()`. It exists to reconstruct the original upstream URL when a legacy/buggy extension build appends it to the proxy URL without `encodeURIComponent()`, which otherwise splits the upstream URL's own query params into separate, sibling `url` params. No behavior changed, just documented what was already there.
- Consolidated README.md: it carried its own hand-maintained "2.2.6 optimization profile" / "2.2.7 maintenance pass" bullet lists that duplicated CHANGELOG.md almost verbatim — the same kind of multi-file drift risk that caused the version-string bug fixed in 2.2.4 and again in 2.2.7. README now links to this file instead of maintaining a second copy of the release history.
- No query parameters, response headers, status codes, or other client-visible behavior changed. `yarn.lock` is intentionally left for the repository's existing `Generate yarn.lock` GitHub Action to regenerate on the next push to `main` (it already triggers on `package.json` changes) rather than hand-editing a lockfile without the ability to run `yarn install` here.

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


# BHP2 — Optimization & Compatibility Review

A running audit log for this project, started with the 2.2.5 → 2.2.7 pass
below and extended with each subsequent review.

## 2.2.7 → 2.2.8 pass

Scope: dependency freshness and documentation, not application logic — the
2.2.7 pass below had already brought `functions/index.js`, `util/validate.js`,
and the test suite into good shape, and this pass found nothing further to
change there.

- **Checked every pinned dependency against its current upstream release**:
  `sharp` (0.35.4) and the Node.js engine pin (22.23.2) were already the
  latest available — left unchanged. `undici` (7.26.0) was 3 patch releases
  behind 7.29.1, which fixes several disclosed issues; bumped within the 7.x
  line (see `CHANGELOG.md` for why 8.x wasn't adopted here). `netlify-cli`
  (dev-only) bumped to its current latest.
- Found and fixed a real gap: `util/version.js` (added in 2.2.7) was never
  added to the `npm run validate` script, so a syntax error in it wouldn't
  have been caught until the test suite happened to import it.
- Documented (did not change) the previously-unexplained array/JSON-rejoin
  branch in `getImageUrl()` — see the code comment and `CHANGELOG.md`.
- Consolidated `README.md`'s duplicated per-version bullet lists into a
  pointer at `CHANGELOG.md`, and clarified the DNS-recommendation table.
- `yarn.lock` was intentionally left for the repository's own
  `Generate yarn.lock` GitHub Action to regenerate on the next push, since
  this pass had no network access to run `yarn install` and hand-editing a
  lockfile's resolved integrity hashes without that would be worse than
  leaving it for the existing automation it was built for.

## 2.2.5 → 2.2.7 pass

### Scope

Compared the two uploaded archives (`2.2.5` and `2.2.6`), cross-checked the backend
contract against the live `anT0ny54/bhp2`, `anT0ny54/bandwidth-guardian`, and
`himshim/*` repositories, and produced a merged, audited `2.2.7` build starting
from `2.2.6` (the more advanced of the two).

### Compatibility verified against upstream

Confirmed directly against the Bandwidth Guardian repo/README that the contract
this proxy implements is exactly what the extension expects:

- Accepts `?url=<encoded>&quality=<n>&bw=0|1&jpeg=0|1&max_width=<n>`, plus the
  legacy `l` quality alias.
- Returns the literal string `bandwidth-hero-proxy` for a no-`url` request
  (used by extensions to validate the proxy URL).
- `x-bh-*` telemetry headers plus legacy `x-original-size` / `x-compressed-size`
  / `x-bytes-saved` headers, used by Bandwidth Guardian's usage-stats tracking.

No contract changes were made or needed — compatibility with Bandwidth Guardian,
Bandwidth Hero MV3, and bandwidth-hero-proxy2 is fully preserved.

### What 2.2.6 already did well (kept as-is)

- WebP encoding at Sharp effort 6 (smaller output) with `minSize`/`mixed` for
  animated WebP.
- URL-fragment stripping before building the cache key (fragments are never
  sent over HTTP, so keeping them just fragmented the cache).
- Longer, still-correct public cache lifetimes (24h browser / 30d edge).
- DNS-rebinding-safe fetching: every hop (including redirects) is re-resolved,
  re-validated against private-IP ranges, and pinned to the validated
  addresses via an `undici` dispatcher — this is materially stronger than the
  upstream `bandwidth-hero-proxy2` reference implementation.

### Bugs found and fixed in this pass (2.2.7)

#### 1. Recurring version drift (real, user-visible bug)
`functions/index.js` reported `2.2.6`, but `functions/health.js` and
`package.json` still said `2.2.5`. This is visible on the diagnostics page
(`site.js` prints `data.version` from `/api/health`) and in the
`X-BH-Version` response header. Checking the project's own CHANGELOG shows
this exact class of bug already happened once before (2.2.2 → 2.2.3 drift,
fixed in 2.2.4) and simply regressed again, because the version string was
hand-copied into multiple files.

**Fix:** added `util/version.js` exporting `PROXY_VERSION`, `API_VERSION`, and
`FEATURES` as the single source of truth. Both `functions/index.js` and
`functions/health.js` now import from it. `package.json` still needs a manual
bump (npm doesn't support importing a value into it), so a new test
(`keeps the proxy version in sync...`) now asserts `package.json`, the health
endpoint, and the `X-BH-Version` header all agree — this will fail loudly if
the drift ever happens a third time, instead of quietly shipping.

#### 2. Stale documentation
`docs/backend-contract.md` still showed the pre-2.2.6 `Cache-Control:
max-age=3600` example and an `X-BH-Version: 2.2.5` example after the 2.2.6
cache/version changes landed. Fixed both, plus a leftover "4.4 MB" mention
that should have read "4.3 MB" after that safety margin was reduced.

#### 3. Redundant work in the request path
- `getRequestHeaders(event)` was being rebuilt from `event.headers` on every
  iteration of the redirect loop, even though the client's original request
  headers don't change across hops. Hoisted the header build outside the
  loop.
- Cookie detection and header normalization each independently re-scanned
  and re-lowercased `event.headers`. Consolidated into one normalization
  pass (`getNormalizedHeaders`), computed once per invocation and reused by
  both.

Neither of these was a correctness bug, just wasted CPU cycles on every
proxied request (small in absolute terms, but purely redundant).

#### 4. Fragile tests tied to incidental encoder byte counts
Three tests asserted exact compressed-size relationships for trivial
synthetic images — e.g. "a 1x1 PNG must compress *larger* as WebP than the
original." Measuring directly with the installed Sharp/libvips build showed
this assumption doesn't hold universally: a 1x1 PNG (91 bytes) compressed to
a 44-byte WebP with the project's current encoder settings, so the "keep the
original because compression made it bigger" fallback path never actually
triggered — the test was failing for reasons unrelated to any real
regression, purely because of which libvips minor version happened to be
installed.

**Fix:** these tests now force `jpeg=1` and compare against JPEG's fixed
container overhead (JFIF header, Huffman/quantization tables), which
reliably exceeds a hand-crafted tiny PNG's size regardless of the installed
libjpeg/mozjpeg version — a structural property of the format, not an
encoder tuning detail. The "JPEG legitimately compresses smaller" test now
uses a deterministic photo-like fixture (a small seeded gradient+noise
pattern) instead of a flat solid color, since a flat color is a worst case
for any lossy format (near-zero-entropy content that lossless PNG already
compresses to almost nothing).

### Verification

- `node --check` passes for every source file (`functions/index.js`,
  `functions/health.js`, `util/validate.js`, `util/version.js`).
- Full test suite (32 tests, including one new regression test) passes
  against Sharp 0.34.5 locally. Production pins Sharp `0.35.4` via
  `package.json`/`yarn.lock`; the fixed tests were specifically chosen to be
  robust to that kind of version difference rather than tied to one specific
  build's output.
- No query parameters, response headers, status codes, or other
  client-visible behavior changed. This is a bug-fix and cleanup pass, not a
  behavior change — Bandwidth Guardian and Bandwidth Hero MV3 compatibility
  is unaffected.

### Recommended deployment profile with Bandwidth Guardian

For maximum practical savings on mobile Chromium:
- Keep WebP detection enabled in Guardian so BHP2 receives WebP requests when supported.
- Keep `grayscale=true` only when grayscale is acceptable for the sites being browsed.
- Keep `maxWidth` around 1280 for phone-class displays; increasing it mainly increases transferred bytes.
- Keep quality around 40 as the baseline; lowering it further trades visible quality for smaller payloads.
