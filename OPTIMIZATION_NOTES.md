# BHP2 — Optimization & Compatibility Review (2.2.5 → 2.2.7)

## Scope

Compared the two uploaded archives (`2.2.5` and `2.2.6`), cross-checked the backend
contract against the live `anT0ny54/bhp2`, `anT0ny54/bandwidth-guardian`, and
`himshim/*` repositories, and produced a merged, audited `2.2.7` build starting
from `2.2.6` (the more advanced of the two).

## Compatibility verified against upstream

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

## What 2.2.6 already did well (kept as-is)

- WebP encoding at Sharp effort 6 (smaller output) with `minSize`/`mixed` for
  animated WebP.
- URL-fragment stripping before building the cache key (fragments are never
  sent over HTTP, so keeping them just fragmented the cache).
- Longer, still-correct public cache lifetimes (24h browser / 30d edge).
- DNS-rebinding-safe fetching: every hop (including redirects) is re-resolved,
  re-validated against private-IP ranges, and pinned to the validated
  addresses via an `undici` dispatcher — this is materially stronger than the
  upstream `bandwidth-hero-proxy2` reference implementation.

## Bugs found and fixed in this pass (2.2.7)

### 1. Recurring version drift (real, user-visible bug)
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

### 2. Stale documentation
`docs/backend-contract.md` still showed the pre-2.2.6 `Cache-Control:
max-age=3600` example and an `X-BH-Version: 2.2.5` example after the 2.2.6
cache/version changes landed. Fixed both, plus a leftover "4.4 MB" mention
that should have read "4.3 MB" after that safety margin was reduced.

### 3. Redundant work in the request path
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

### 4. Fragile tests tied to incidental encoder byte counts
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

## Verification

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

## Recommended deployment profile with Bandwidth Guardian

For maximum practical savings on mobile Chromium:
- Keep WebP detection enabled in Guardian so BHP2 receives WebP requests when supported.
- Keep `grayscale=true` only when grayscale is acceptable for the sites being browsed.
- Keep `maxWidth` around 1280 for phone-class displays; increasing it mainly increases transferred bytes.
- Keep quality around 40 as the baseline; lowering it further trades visible quality for smaller payloads.
