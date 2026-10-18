# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`
and this file together.

Releases before 2.2.21 were not recorded here. Their history is available in
the git log; it is deliberately not reconstructed from memory.

## [2.2.25] - 2026-10-18

A second full read-through of every file in the repository (both functions, all
four `util/` modules, all six test suites, CI workflows, Netlify config, docs
and the lockfile), followed by the complete local gate
(`yarn run check`: syntax check, Sharp native-pin check and all 76 tests —
all passing). No dead code, unused exports, debug statements, environment
variables or lint violations were found, and no code defects surfaced, so this
release changes documentation only.

### Docs

- `README.md`: the intro now names the current release and links the changelog
  and backend contract up front; the testing section cross-references the
  suite table; and a few wordings were tightened. No factual content changed.
- `docs/backend-contract.md`: the version-history table gained the 2.2.25 row
  and the example `X-BH-Version` header in the response sample was synced.
- No behavioral change: `util/version.js` and `package.json` were bumped to
  2.2.25 only to keep the version-consistency test green.

## [2.2.24] - 2026-10-17

Full read-through of every file in the repository (code, tests, CI, docs and
lockfile). The address policy was also fuzzed against an independent BigInt
oracle (450,000 checks over 300,000 random IPv4/IPv6 addresses, IPv6 in both
letter-cases, including mapped, NAT64 and 6to4 forms; no mismatches). Only the
defects below needed a code change.

### Fixed

- **Telemetry headers are now readable by CORS-bound callers.** Responses sent
  `Access-Control-Allow-Origin: *` but no `Access-Control-Expose-Headers`, so a
  web page or content script making a cross-origin request could not read the
  `x-bh-*` headers or the legacy `x-original-size` / `x-compressed-size` /
  `x-bytes-saved` headers that the README documents for statistics. All ten
  are now listed in `BASE_HEADERS` (`util/headers.js`), so every response,
  including errors, the handshake, `/api/health` and preflights, carries the
  header. Callers that bypass CORS were unaffected.
- **The light theme's "Failed" status colour was hard to read.** The light
  theme inherited the dark theme's `--danger` (`#fb7185`), which is 2.69:1
  against the white status rows (WCAG AA for small text needs 4.5:1). It now
  has its own value, `#c8283f` (5.48:1 on white).

### Docs

- `docs/backend-contract.md`: new **CORS** section listing the exact header
  set (checked against the code); a note that the 20 s request budget assumes
  Netlify's documented 30 s default for synchronous Functions, with the worst
  case (a last fallback encode starting just before 20 s and running for the
  8 s Sharp timeout, about 28 s) and what to change if the site uses a shorter
  timeout; and a **known limitation** in Caching: `Referer` and `DNT` are
  forwarded but are not part of the cache key, so a host that varies its
  response by `Referer` is cached by whichever request came first.
- `README.md`: the same three points in the feature list, the new test
  counts, the suite table, and the "what the suites do not establish" note
  (redirects to private targets are now covered).
- A comment in `tests/integration.test.js` claimed that nothing
  request-specific reaches upstream, which contradicted the same test
  asserting that `Referer` is forwarded. It now says what is actually fixed
  and what is not.

### Tests

- 76 tests (was 72): `test:fast` is now 36 (was 34) and `test:integration` is
  40 (was 38).
  - `tests/integration.test.js`: every `x-*` telemetry header is exposed and
    every exposed name is actually sent (fails on 2.2.23); a redirect to a
    private or local target (`169.254.169.254`, IPv4-mapped IPv6,
    `localhost`, loopback, RFC 1918) returns `403` with the real resolver and
    address policy on every hop after the first. This closes the gap the
    README listed; the behavior itself was already correct on 2.2.23.
  - `tests/site.test.js`: status colours meet 4.5:1 against the status rows in
    both themes (fails on 2.2.23).
  - `tests/health.test.js`: every `tests/*.test.js` file is listed in the
    `package.json` scripts and sits in exactly one of `test:fast` or
    `test:integration`. The scripts name files explicitly, so an unlisted file
    would otherwise never run in CI. Passes on 2.2.23; guards future changes.
