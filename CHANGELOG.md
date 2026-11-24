# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`,
`README.md` and this file together.

Only the latest release and its most recent modification log are kept here.
Releases before 2.2.25 are not recorded here; their history is available in
the git log and is deliberately not reconstructed from memory.

## [2.2.28] - 2026-10-24 (modified 2026-11-25, version unchanged)

Latest modification log. The version is still 2.2.28.

### Changed

- `functions/index.js`: the 20 s request/fallback deadline now uses
  `performance.now()` from `node:perf_hooks` instead of `Date.now()`. The
  deadline is elapsed-time logic, so a wall-clock correction must not extend
  the fallback window or make it expire early. The request-start timestamp and
  every deadline comparison now use the same monotonic clock.
- `tests/compress.test.js`: strengthened the expired-deadline regression by
  moving `Date.now()` backwards while keeping the monotonic deadline expired.
  This now fails if a future change reintroduces a wall-clock comparison.
- `tests/integration.test.js`: added a zero-budget handler regression that
  moves the wall clock forward and verifies the handler's start timestamp and
  compression deadline checks share the same monotonic time source.
- `.nvmrc`: pins Node.js 22.23.5, the current Node 22 LTS security release.
  Netlify reads this file directly, and both GitHub Actions workflows now use
  `node-version-file`; the duplicate Node version setting was removed from
  `netlify.toml`. This keeps deployment builds and CI on one version source.
- `tests/health.test.js`: added a guard that Netlify and both workflows use
  `.nvmrc`, that no competing Node version override remains in `netlify.toml`,
  and that the pin satisfies `package.json`'s minimum Node requirement.
- `tests/integration.test.js`: moved the three-frame WebP fixture's metadata
  assertion into its shared helper and removed the duplicate assertion from
  one consumer. Every test now verifies that the fixture is actually animated
  before asserting proxy behavior.
- `README.md`: clarifies that `.nvmrc` is the single Node.js version source,
  documents the monotonic request-budget behavior and test totals, and explains
  the Sharp `raw.pageHeight` requirement for the multi-frame fixtures.

### Audit without change

- Reconstructed the cumulative project from the supplied `bhp2-main.zip`, then
  applied `bhp2-final-modified-files.zip`,
  `bhp2-reaudit-modified-files.zip`, `bhp2-round4-modified-files.zip` and
  `bhp2-round5-modified-files.zip` in that order. The resulting tree contained
  32 files and 5,157 lines before this round's documentation edits. Every file,
  including the complete dependency lockfile, was read in full before
  judgement.
- Compared the merged tree with the original base. The cumulative delta remains
  exactly 10 paths; this round did not require another production-code change.
  No additional unused production declarations, imports or exports, conflicting
  configuration, or production-code defects were found. No further dead or
  redundant production code was safe to remove without changing behavior, and
  no performance tuning was justified without deployment benchmarks.
- Rechecked the HTTP/SSRF policy, redirect handling, response headers,
  image-size limits, adaptive fallback, monotonic request budget, health
  endpoint, diagnostics page, release metadata, Node.js version source and
  workflow configuration against their tests and `docs/backend-contract.md`.
  The existing Node.js 22.23.5 pin is retained in `.nvmrc` and remains the sole
  version source for Netlify and both GitHub Actions workflows.
- The README's CI description now explicitly includes manual
  `workflow_dispatch`, matching `.github/workflows/ci.yml`. The README's test
  totals and Sharp fixture compatibility note were checked against the current
  package scripts and test suite.

### Verification

- Every checked-in `.js` and `.mjs` file passes `node --check`.
- All 59 network-free tests pass on Node.js 22.16.0 with the available global
  Sharp 0.34.1.
- The integration/compression run passes 48 of 51 tests with Sharp 0.34.1.
  The three failures depend on multi-frame fixtures created with Sharp's
  `raw.pageHeight` input option, which was added in Sharp 0.34.3; the available
  0.34.1 build therefore returns static images. The shared three-frame helper
  now asserts its frame count immediately, so both consumers fail at fixture
  creation rather than producing a misleading downstream proxy assertion.
  These are dependency-version fixture failures, not verified source-code
  regressions. The suite still needs a run with the pinned Sharp 0.35.5.
- `yarn run check` and `yarn install --frozen-lockfile` could not be run because
  Yarn is not installed. The direct Sharp pin check correctly rejects the
  available global 0.34.1 build and its native packages, which do not match the
  repository's Sharp 0.35.5 / libvips 1.3.4 pins.
- Not verified: a real browser, live internet hosts, a Netlify Deploy Preview,
  real deployment latency, memory use, cold starts, artifact size or
  concurrent-load safety.
