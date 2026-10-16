# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`
and this file together.

Releases before 2.2.15 were not recorded here. Their history is available in
the git log; it is deliberately not reconstructed from memory.

## [2.2.19] - 2026-10-17

### Fixed

- **Explicit JPEG requests now remain JPEG.** Static `jpeg=1` requests no longer
  fall back to the original PNG/WebP merely because the JPEG encoding is larger;
  animated sources are still passed through unchanged because JPEG cannot
  represent animation.
- **Animated WebP integration fixture is genuinely multi-frame.** The test now
  uses Sharp's raw multi-page input with distinct frames, avoiding a false
  failure caused by treating an array of encoded buffers as animation.

