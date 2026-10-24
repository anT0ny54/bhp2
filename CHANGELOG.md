# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`,
`README.md` and this file together.

Releases before 2.2.25 are not recorded here. Their history is available in
the git log; it is deliberately not reconstructed from memory.

## [2.2.28] - 2026-10-24

A full read-through of every file in the repository, then the complete local
gate (all 76 tests passed before the change; 77 pass after). No functional
bug was found in the request path. The changes below remove redundancy, drop
needless work and close two documentation conflicts. No API change.

### Changed

- `util/validate.js`: public IP-literal URLs (e.g. `http://8.8.8.8/`,
  `https://[2606:4700:4700::1111]/`) are pinned directly. They used to be
  passed to `dns.lookup()` and raced against a timer and an abort listener
  just to get the literal back. The address policy and the shared-deadline
  check still run first, so results are identical.
- `util/validate.js`: the abort-signal promise in the DNS race is only created
  when a signal is supplied (it used to be a never-settling promise
  otherwise), and the unused `catch (error)` binding is gone.
- `site.css`: `min-height: 100dvh` after the `100vh` fallback, so the page does
  not overflow the visible viewport on mobile browsers with a collapsing
  address bar.

### Removed

- `functions/index.js`: `createBinaryResponse()` rebuilt the response object
  and header merge by hand. It now wraps `createResponse()` from
  `util/headers.js`, the documented single source of that shape, and the
  `BASE_HEADERS` import is dropped. Headers and body are unchanged.

### Fixed

- `README.md` (Release Policy): documentation updates were listed under minor
  releases, although docs-only releases (2.2.25) were shipped as patches.
  Documentation corrections are now patch-level. The policy also lists
  `README.md` among the files every release must update.
- `CHANGELOG.md` preamble: same file list.

### Tests

- `tests/address-policy.test.js`: new test for direct pinning of public IPv4
  and IPv6 literals, 403 for a private IPv6-mapped literal, and an already
  aborted deadline taking precedence. Suite totals are now 77 tests: 39 fast
  and 38 integration.
- `tests/health.test.js`: the version-sync test also requires the sample
  `X-BH-Version` header in `docs/backend-contract.md`, the release number in
  `README.md`, and the newest `CHANGELOG.md` entry to match `PROXY_VERSION`.

### Docs

- `README.md`: release number, test totals, suite descriptions, Release
  Policy. `docs/backend-contract.md`: version-history row for 2.2.28 and the
  sample `X-BH-Version` header. `package.json` and `util/version.js` are
  bumped to 2.2.28.

### Follow-up maintenance (2026-10-24; version unchanged)

- Changed: `site.js` removes an unreachable compression-ratio fallback and
  reads savings telemetry only after image validation succeeds.
- Changed: `README.md` documents that behavior.
- Fixed: the transient 78-test note in the 2.2.26 follow-up used the wrong
  fast/integration split and was superseded. Current checked-in totals remain
  77 tests: 39 fast and 38 integration. Historical release headings and the
  project version are unchanged.

Second pass (2026-10-24; version unchanged)

- Fixed: `functions/index.js` `encodeImage()` passed `useWebp` as the Sharp
  decode pipeline's `animated` flag instead of its own `animated` parameter.
  Reachable behavior was unchanged — animated sources never reach the JPEG
  encoder (the handler passes them through first) and static sources encode
  identically either way — but the invariant was only implicit and the
  argument misleading. The pipeline now uses `animated` directly.
- Fixed: `scripts/check-sharp-pins.mjs` now prints "run `yarn install` first"
  and exits 1 when `node_modules/sharp` is absent, instead of a raw `ENOENT`
  stack trace.
- Changed: `package.json`'s `validate` script syntax-checks every shipped JS
  file (`site.js`, both functions, all four `util/` modules, the pins
  script), not just `site.js`; a syntax slip in the function code now fails
  `yarn run check` locally instead of at Netlify build time.
- Verified: the complete local gate passes after these changes: the syntax
  check of every shipped JS file, the Sharp native-pin check, and all 77
  tests (39 fast and 38 integration). The documented totals and the
  "yarn.lock has 32 entries" claim were re-confirmed against the checked-in
  files.
- Note: an earlier draft of this pass also changed a `let` to `const` in
  `site.js`; the suite caught that the flag is reassigned inside the loop, so
  the change was reverted before shipping. `site.js` is unchanged.

Third pass (2026-10-24; version unchanged)

- Verified: the no-URL handshake already returns the documented
  `Cache-Control: public, max-age=300`; no handler change was needed.
- Tests: `tests/index.test.js` now asserts that documented cache header so the
  contract cannot drift silently.
- Docs: `README.md` now describes the handshake as cacheable and includes it in
  the `tests/index.test.js` scope. No version bump; checked-in test totals
  remain 77 tests.

