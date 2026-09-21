# Changelog

Release notes for versions before 2.2.9 were not present in this copy of the
file; see the git history for earlier releases.

## 2.2.9

### Fixed
- Upstream fetch deadline now covers the body download as well as the headers.
  Previously the timer was cleared once headers arrived, so a slow-drip
  upstream could hang until the platform killed the function. Timeouts return
  `504` in both cases.
- `Cookie` is no longer forwarded to a different origin when following a
  redirect; it is only sent to the origin of the original request.
- A malformed `Location` header on an upstream redirect returns `502` instead
  of an unhandled `500`.
- Unread redirect/error response bodies are cancelled and each hop's pinned
  undici dispatcher is destroyed when the request finishes, releasing sockets.
- The DNS lookup timeout timer is now cleared after the lookup settles instead
  of lingering for 2 seconds per request.
- Empty `quality=` now falls back to the legacy `l` parameter.
- SSRF hardening: block IPv6 site-local (`fec0::/10`), and judge NAT64
  (`64:ff9b::/96`) and 6to4 (`2002::/16`) addresses by their embedded IPv4.
- `package.json` `engines.node` was pinned to exactly `22.23.2`, which makes
  `yarn install` fail on any other Node version and contradicted the README
  (22.13 or later). It is now `>=22.13.0`; Netlify still uses 22.23.2.
- Diagnostics page keeps the "Sharp unavailable" message instead of
  overwriting it with a generic HTTP error.
- README: fixed a broken code span in the DNS endpoint list and removed
  conflicting version numbers in the release-history note.

### Changed
- Removed the redundant per-hop AbortController helper and the duplicated
  `user-agent`/`accept-language` forwarding entries.
- `npm run validate` also syntax-checks `site.js`.
- Version bumped to 2.2.9 in `package.json`, `util/version.js`,
  `docs/backend-contract.md` and `README.md`.

### Tests
- Added tests for cookie handling on redirects, invalid redirect locations,
  body-stall timeout, and the new IPv6 ranges.
