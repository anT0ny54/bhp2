# Changelog

All notable changes to this project are documented in this file. Versioning
follows the Release Policy section of [README.md](README.md): every
release updates `package.json`, `util/version.js`, `docs/backend-contract.md`,
`README.md` and this file together.

Only the latest release and its most recent modification log are kept here.
Releases before 2.2.25 are not recorded here; their history is available in
the git log and is deliberately not reconstructed from memory.

## [2.2.28] - 2026-10-24 (modified 2026-11-09, version unchanged)

Latest modification log. The version is still 2.2.28. Only verifiable changes
are listed.

### Changed

- `site.js`: diagnostics now require all three image-size telemetry headers to
  be positive/valid safe integers (zero is allowed only for bytes saved) and
  for `bytes saved` to agree with original and compressed sizes. A successful
  image response with invalid telemetry is reported as a failed compression
  check; its body is cancelled instead of being read as an error message.
- `tests/site.test.js`: added regression coverage for missing, malformed and
  inconsistent telemetry headers. The diagnostics badge now reports `Proxy online`
  only after the API handshake, compression telemetry and the Cache-Control policy check
  all pass; handshake, compression and cache failures receive distinct failure
  labels. A health check reporting missing Sharp remains a failure, and the
  page skips the follow-on image request.
- `tests/health.test.js`: the test-wiring guard now checks the raw suite-file
  lists for duplicates before comparing them with every checked-in test file.
  The former `Set`-based comparison could silently hide duplicate entries.
- `site.js`: Copy URL feedback reset callbacks now check the click generation
  before changing the label. This prevents an already-queued timer from
  overwriting the feedback for a newer clipboard request after `clearTimeout`.
  `tests/site.test.js` covers the stale-callback race.
- `site.js` and `index.html`: the diagnostics check is now labelled as a
  `Cache-Control` policy check. Its success detail reports only that the
  `public` directive is present; it no longer implies that a Netlify edge cache
  hit was verified. A present but non-public header is described accurately
  rather than called missing. `tests/site.test.js` covers both details.
- `functions/index.js` behavior is now covered by integration regressions for a
  DNS resolver that returns after the shared deadline and a redirect hostname
  whose test-resolved address is private. The former must not start an upstream
  request after timeout; the latter must be rejected on the redirect hop.
- `netlify.toml`, `.github/workflows/ci.yml` and
  `.github/workflows/update-yarn-lock.yml`: updated the Node.js 22 runtime pin
  from 22.23.3 to the 22.23.4 security release. The application version stays
  at 2.2.28.

### Docs

- `README.md` and `docs/backend-contract.md`: updated the synchronous Netlify
  Functions limit to 60 s, matching the current [Netlify Functions documentation](https://www.netlify.com/knowledge-base/how-to-add-a-backend-api-endpoint-with-netlify-functions/)
  rather than the obsolete 30 s description. The docs still advise checking
  the limit that applies to the actual site and plan.
- `README.md`: refreshed the test totals (84 overall, 44 network-free and 40
  integration tests), documented the diagnostics badge behavior and its
  `Cache-Control: public` check, and explained how to inspect Netlify's actual
  edge-cache behavior with `Cache-Status`. It also describes the resolver-deadline
  and simulated private-DNS redirect coverage and their remaining limits, and
  warns that the integration suite must run with the exact Sharp version in
  `yarn.lock`; a different global Sharp release can invalidate the animated-image
  fixtures and native-package pin check.

### Verification

- The round-two patch was applied to a fresh extraction of `bhp2-main.zip`, and
  all 30 resulting project files (source, tests, workflows, lockfile and
  documentation) were read in full. All checked-in tests are wired into exactly
  one suite. No dead source file or unreferenced helper was found. This audit
  corrected two misleading diagnostics messages about Cache-Control and edge
  cache verification; the earlier copy-feedback timer race remains covered by
  its regression test. No compatibility or security code was removed on
  appearance alone.
- `npm run validate` passes on the available Node.js 22.16.0 runtime;
  `npm run test:fast` passes all 44 network-free tests.
- With the only locally available Sharp (global 0.34.1; the project pins 0.35.5),
  38 of 40 compression/integration tests pass. The two failures happen in
  fixture preconditions: Sharp 0.34.1 does not report the generated WebP
  fixtures as multi-frame. They do not establish a failure in the proxy's
  animated-image handling, which remains to be verified with pinned Sharp
  0.35.5.
- The Sharp native-pin guard was run against the temporary Sharp 0.34.1 link
  and correctly rejected all four mismatched native pins. A positive pin check
  against the project's Sharp 0.35.5 could not be run. The full
  `yarn run check` gate was not run because Yarn and project-local Sharp 0.35.5
  are not installed in this environment. The temporary link was removed after
  the test run. No application version or dependency pin was changed.
