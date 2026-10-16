# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`
and this file together.

Releases before 2.2.15 were not recorded here. Their history is available in
the git log; it is deliberately not reconstructed from memory.

## [2.2.18] - 2026-10-16

### Fixed

- **Sharp processing timeouts are now enforced.** Sharp's default processing
  timeout is disabled, so the existing 504 mapping alone could not bound a
  stalled libvips pipeline. Each Sharp pipeline now has an 8-second processing
  timeout, and timeout messages are mapped to `504` even when Sharp does not
  use the `TimeoutError` name. Time waiting for a libuv worker is excluded by
  Sharp, and the limit is per pipeline rather than a whole-request deadline.
- **Width fallback no longer raises explicitly low quality requests.** When a
  request uses a quality below the codec's fallback floor, the resize fallback
  now keeps the requested quality instead of increasing it to 10 (WebP) or 20
  (JPEG).
- **Integer query parameters reject numeric prefixes with trailing junk.**
  Values such as `max_width=320px` now use the documented default instead of
  being partially parsed as a valid integer.

### Documentation

- Corrected the current test totals to 44 overall, 23 fast, and 21 compression/
  integration tests; clarified the Sharp timeout and stated the input cap in
  MiB rather than ambiguous MB units.
