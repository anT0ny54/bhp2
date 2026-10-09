# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`
and this file together.

Releases before 2.2.15 were not recorded here. Their history is available in
the git log; it is deliberately not reconstructed from memory.

## [2.2.15] - 2026-10-10

### Fixed

- **Adaptive size fallback no longer runs out of widths.** When quality alone
  could not bring an image under the 4.3 MB response target, the width
  fallback skipped every size at or above `max_width` and stopped at 320 px.
  For `max_width` of 320 or less (for example 100 or 320) that left nothing to
  try and the request failed with `413` even though a smaller image would have
  fit. Fallback widths are now built by `buildFallbackWidths()`: always
  strictly below the requested `max_width`, continuing down to 16 px (and
  halving to 1 px for limits of 16 px or less). Images are still never
  enlarged and the 4.3 MB ceiling is unchanged.
- **`192.0.0.0/16` is no longer blocked as a whole.** The previous rule
  rejected all of `192.0.0.0/16`, which includes ordinary public hosts. Only
  the IANA special-purpose ranges `192.0.0.0/24` and `192.0.2.0/24` are
  rejected now.

### Security

- **The 8 s fetch deadline now covers DNS resolution.** The DNS step observes
  the shared abort signal, so a stalled resolver is abandoned at the deadline
  instead of lingering until its own 2 s timeout. The deadline is also checked
  before every redirect hop and immediately before each upstream request, so
  no request is started after it has passed, and a DNS answer that arrives
  late is discarded.
- **Explicit, table-driven address policy.** Reserved-range coverage is now
  defined by two CIDR tables in `util/validate.js`
  (`BLOCKED_IPV4_CIDRS`, `BLOCKED_IPV6_CIDRS`), compared against the IANA
  special-purpose registries. Newly rejected IPv4 ranges: `198.51.100.0/24`,
  `203.0.113.0/24` (documentation) and `192.88.99.0/24` (deprecated 6to4
  relay). IPv6 now only considers global unicast `2000::/3` and rejects
  everything outside it (including `100::/64`, `64:ff9b:1::/48` and the
  deprecated IPv4-compatible `::/96`) plus the special-purpose carve-outs
  `2001::/23` (Teredo, benchmarking, ORCHID, ...), `2001:db8::/32` and
  `3fff::/20` (documentation). IPv4-mapped, NAT64 (`64:ff9b::/96`) and 6to4
  addresses are still judged by their embedded IPv4 address. Global unicast
  space is not blanket-blocked.

### Added

- Integration test suite (`tests/integration.test.js`) using local HTTP
  servers: redirect handling and cross-origin `Cookie`/`Referer` stripping,
  socket pinning, input size limits, slow and stalled upstreams, shared-deadline
  behaviour (including stalled DNS and redirect chains), malformed and
  truncated images, WebP/JPEG output, grayscale, resizing, animation
  preservation, the never-enlarge fallback and header correctness for
  unmodified originals.
- Compression tests (`tests/compress.test.js`), including regression tests for
  `max_width` of 100, 320 and 800.
- Address-policy tests (`tests/address-policy.test.js`) with boundary checks
  for every CIDR in both policy tables.
- GitHub Actions workflow `.github/workflows/ci.yml`: runs `yarn run check` on
  pull requests and on pushes to `main`, using a frozen lockfile.
- `test:fast` and `test:integration` package scripts; `test` runs both.

### Documentation

- README: the Netlify section described the full `node_modules/@img` tree,
  but `netlify.toml` includes only the Sharp JavaScript package and the Linux
  x64 native packages. README now matches the configuration and explains that
  the ARM64 `optionalDependencies` exist for installs on ARM64 machines, not
  for the deployed function.
- README and `docs/backend-contract.md`: documented the address policy, the
  deadline semantics and the new test suites.
- This changelog.
