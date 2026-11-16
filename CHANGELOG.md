# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`,
`README.md` and this file together.

Only the latest release and its most recent modification log are kept here.
Releases before 2.2.25 are not recorded here; their history is available in
the git log and is deliberately not reconstructed from memory.

## [2.2.28] - 2026-10-24 (modified 2026-11-16, version unchanged)

Latest modification log. The version is still 2.2.28.

### Fixed

- `util/validate.js`: the pinned DNS `lookup` callback now honours Node's requested
  address family for both single-address and `all` lookups, including numeric and
  `IPv4`/`IPv6` selectors. It returns `EAI_ADDRFAMILY` instead of falling back to
  an address from the wrong family. Regression coverage is in
  `tests/address-policy.test.js`.
- `site.js`: a successful (`2xx`) image response that fails image validation is now reported
  as an unexpected image response, not as `HTTP 200`. This includes invalid
  content and missing or inconsistent telemetry headers. Regression assertions
  in `tests/site.test.js`.
- `util/validate.js`: broad IANA special-purpose parent ranges incorrectly
  rejected more-specific IPv4 and IPv6 allocations that the IANA registries mark
  Globally Reachable. Added explicit, narrowly scoped exceptions for `192.0.0.9/32`,
  `192.0.0.10/32`, and the seven globally reachable allocations within
  `2001::/23`. Every other address in the parent ranges remains blocked.
  Regression coverage checks every exception boundary, adjacent blocked
  addresses and IPv4-embedded IPv6 forms.
- `functions/index.js`: an empty `quality=` parameter no longer shadows the
  legacy `l` alias. Previously `quality=&l=20` ignored `l` and used the default
  quality 60, because `??` only skips null and undefined. The value is now read
  through `getQualityParameter()`, where an empty `quality` counts as absent.
  `quality=0` still clamps to 1. Regression test in `tests/index.test.js`.
- `netlify.toml`: the comment said no site-wide headers were duplicated, but the
  `/*` block repeats `X-Frame-Options`, `X-Content-Type-Options` and
  `Referrer-Policy` from `util/headers.js`. The comment now says so. A test in
  `tests/health.test.js` fails if those values drift apart.

### Changed

- `functions/index.js`: removed the `cacheHeaders` alias and the parameter that
  threaded the same `PUBLIC_CACHE_HEADERS` object through
  `createBinaryResponse()` and `createOriginalResponse()`. Response headers are
  unchanged.
- `tests/fixtures.js`: consolidated the shared PNG noise fixture previously
  duplicated in `tests/compress.test.js` and `tests/integration.test.js`.
- `README.md` and `docs/backend-contract.md`: documented the IANA exceptions.
  `README.md` now reports 97 tests overall: 54 network-free and 43 integration.

### Verification

- `node --check` passes for every shipped JavaScript file and test file on Node
  22.16.0.
- The network-free suite passes all 54 tests:
  `node --test tests/index.test.js tests/health.test.js tests/address-policy.test.js tests/site.test.js`.
- The Sharp pin check and Sharp-dependent compression/integration suites could
  not run: `node_modules/sharp` is absent, and Corepack could not retrieve the
  pinned Yarn 1.22.22 package because the Yarn registry was unreachable
  (`EAI_AGAIN`).
- Not verified here: a Netlify deploy preview, real internet hosts, and real
  Netlify latency or memory.
