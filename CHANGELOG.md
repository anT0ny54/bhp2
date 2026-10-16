# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`
and this file together.

Releases before 2.2.19 were not recorded here. Their history is available in
the git log; it is deliberately not reconstructed from memory.

## [2.2.20] - 2026-10-17

### Fixed

- **A body that stalls mid-download now returns `504`, not `502`.** The 5 s
  socket inactivity timer now aborts the same controller as the 8 s deadline,
  so a stall before the headers, between bytes or mid-body is always reported
  as `504 Upstream image request timed out.` (previously
  `502 Upstream connection failed [ECONNRESET].`).
- **Legacy clients that don't URL-encode the image URL are handled
  correctly.** The image URL is now read from the raw query string. An
  unencoded value (`url=http://…/a.jpg?w=1&h=2&jpeg=0`) keeps its own query
  string up to the first proxy parameter; previously `&h=2` was silently
  dropped and the wrong image was requested. Such responses use
  `Netlify-Vary: query` so different upstream URLs never share a CDN entry.
  Encoded URLs (Bandwidth Guardian) are decoded once, as before.
- **`jpeg=true` selects JPEG**, consistent with `bw=true`. WebP remains the
  default for every other value.
- **The never-enlarge fallback can no longer cache a format another client
  cannot display.** The upstream `Accept` header is now fixed instead of being
  copied from the client, the original's media type comes from the image bytes
  rather than the upstream `Content-Type`, and original bytes are only
  returned when they are JPEG, PNG, GIF, WebP or AVIF. Anything else (TIFF,
  HEIC, JPEG XL, SVG) is always served as WebP.
- **AVIF originals are labelled `image/avif`.** Sharp reports AVIF as `heif`,
  which was previously mislabelled `image/heif`.
- **Cookies are no longer forwarded upstream.** A browser only ever sends the
  proxy origin's own cookies to the proxy, so forwarding them leaked them to
  arbitrary image hosts and disabled CDN caching for those requests. Requests
  are now always publicly cacheable; `Referer` is still forwarded and is
  stripped on cross-origin redirects.
- **Diagnostics page:** a later timeout no longer overwrites an earlier
  "Sharp unavailable" result; checks that were never run show "Skipped"
  instead of "Failed"; the header badge reflects the last diagnostics run
  instead of always saying "online".

### Changed

- **The oversize fallback is bounded and much cheaper.** It now uses one
  lower-quality encode plus width probes chosen by a size model (size ∝
  width^k, re-fitted from the last two measurements), with at most 5 fallback
  encodes. Previously it used a quality loop, a binary search and a full linear
  rescan (up to ~22 full decode/encode passes). Measured on a 6 MP image:
  4–5 encodes / ~4 s instead of 10 encodes / 11–13 s, with the same output
  width. The `413` path drops from 22 to 3 encodes.
- **Whole-request budget of 20 s.** No new fallback encode starts after it; an
  exhausted budget returns `504` instead of the platform killing the function.
- **WebP encoder:** `minSize` was removed (it only affects animations and made
  animated encodes ~3× slower for the same output size); `mixed` is used only
  for animated input.
- **One metadata probe per request** now drives the animated-JPEG
  passthrough, the original-bytes media type and the encoder options; the
  separate fallback-only probe was removed.
- **Every hop, including the first, goes through the single DNS-validated URL
  policy**; the duplicate pre-fetch URL/private-host check in the handler was
  removed (status codes and messages are unchanged).
- **Only server-side failures (5xx) are logged**; expected 4xx outcomes no
  longer produce log noise.
- **`netlify-cli` is no longer a devDependency.** `yarn start` / `yarn dev`
  run it through `npx`. `yarn.lock` shrinks from 977 to 32 entries, CI and
  Netlify builds install only Sharp, and the second Sharp copy (0.34.5 via
  `netlify-cli → ipx`) is gone.
- **Dependabot** groups `sharp` with `@img/sharp-*`, so bumps arrive as one
  PR that passes `check:sharp-pins`.
- DNS lookups use `order: "verbatim"` instead of the deprecated
  `verbatim: true`.

### Removed

- Dead code: unused `setDnsLookupForTests` / `resetDnsLookupForTests`, the
  array/JSON branches of the old URL parser, unreachable IPv4/IPv6 format
  checks, a dead abort re-check in `requestPinned`, a duplicate abort check
  after DNS, `getQueryParameters`, the default-valued `fastShrinkOnLoad`
  option, unused `avif`/`heic` entries in the format map, and hand-built errors
  where `createHttpError` exists.
- Duplicates: `createResponse` is shared from `util/headers.js` by both
  functions; the codec quality floor is defined once.
- `Authorization` from `Access-Control-Allow-Headers` (never read).
- `"main"` from `package.json`, and the hand-maintained `node --check` list for
  modules the tests already import.

### Tests

- 59 tests (was 44). New: mid-body stall → `504`, `jpeg=true`, legacy and
  encoded raw-query URLs, fixed `Accept` and no `Cookie` upstream, `Referer`
  kept/stripped across same/cross-origin redirects, `508` redirect limit,
  never-enlarge with detected type, non-browser formats stay WebP, `413` input
  limit, bounded fallback encode count, and the request budget `504`.

