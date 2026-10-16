# ⚡ Bandwidth Hero Server (bhp2)

A lightweight, serverless image-compression proxy for Bandwidth Hero-compatible
browser extensions (e.g. Bandwidth Guardian).

The service fetches remote images, converts them to WebP or JPEG using Sharp,
optionally applies grayscale conversion and maximum-width resizing, and
delivers optimized versions to dramatically reduce bandwidth usage and speed up
page loads. It ships with a mobile-friendly diagnostics page (`index.html` +
`site.js` + `site.css`) and a JSON health endpoint (`/api/health`).

🖥️ **Live demo:** [Bandwidth Hero](https://bhserv.netlify.app/)

📋 **Changelog:** [CHANGELOG.md](CHANGELOG.md) ·
**API contract:** [docs/backend-contract.md](docs/backend-contract.md)

---

## ✨ Features (verified against the code)

- **WebP output by default** (best compression). Only an explicit `jpeg=1`
  or `jpeg=true` selects JPEG; Bandwidth Guardian always sends `jpeg=0`
- **JPEG output** with `jpeg=1` / `jpeg=true` (mozjpeg, progressive)
- **Grayscale conversion** with `bw=1`
- **Quality control**: `quality` (1–100, default 60; values below 1 clamp to 1, so `quality=0` ⇒ 1) plus legacy alias `l`
- **Maximum-width resizing** (`max_width`, 0 = no limit, capped at 8192; never
  enlarges)
- **EXIF auto-orientation**; metadata is stripped from re-encoded output
- **Animated-image passthrough**: when JPEG output is requested, multi-frame
  sources (GIF/WebP/TIFF/APNG/animated AVIF/HEIF) are returned untouched —
  every `jpeg=1` source is probed for multiple frames from the bytes,
  regardless of Content-Type. If those bytes exceed the 4.3 MB response
  target the request fails with a clear `413` instead of an opaque gateway
  error. WebP output keeps animation.
- **Never-enlarge guarantee (WebP output)**: if the WebP encoding would be
  larger than the source, the original bytes are returned instead, but only
  when they are a format every Chromium browser displays (JPEG, PNG, GIF,
  WebP, AVIF) **and** already match the request (displayed width no wider than
  `max_width` — measured after EXIF rotation, so a portrait-stored photo that
  displays as landscape is judged by its landscape width — and already
  grayscale when `bw=1`). The media type is detected from the bytes,
  not trusted from the upstream `Content-Type`. Other formats (TIFF, HEIC,
  JPEG XL, SVG) are always served as WebP. Explicit `jpeg=1` requests stay
  JPEG even when larger
- **Tolerant decoding**: truncated or slightly corrupt images are still
  compressed (`failOn: "none"`) instead of failing and forcing the client to
  download the full original; non-image data still fails
- **Adaptive output fallback**: to stay under Netlify's 6 MB buffered response
  limit (4.3 MB binary safety target), one lower-quality encode is tried,
  then narrower widths chosen by a size model (size ∝ width^k, re-fitted from
  each measurement). At most 5 fallback encodes run, and none starts after
  the 20 s request budget (`504`). Fallback widths are always strictly below
  a requested `max_width` and continue down to 16 px (1 px for tiny limits);
  images are never enlarged. The worst case is about 28 s (the 20 s budget plus
  one 8 s Sharp pipeline), which fits Netlify's documented 30 s default for
  synchronous Functions; lower `REQUEST_BUDGET_MS` if your site uses a shorter
  function timeout (see the [contract](docs/backend-contract.md#limits))
- **Legacy URL support**: the image URL is read from the raw query string.
  Encoded URLs (Bandwidth Guardian) are decoded once; unencoded legacy URLs
  keep their own query string up to the first proxy parameter and are cached
  with `Netlify-Vary: query`
- **Manual redirect handling**: bounded at 5 hops; every hop is re-resolved,
  re-validated and re-pinned; `Referer` is stripped on cross-origin hops
- **SSRF protection**: HTTP/HTTPS-only URLs; `localhost` and every
  `*.localhost` name are rejected outright; an explicit, table-driven
  address policy covering private, loopback, link-local, CGNAT, documentation,
  benchmarking, multicast and reserved IPv4 **and** IPv6 ranges (IPv6 allows
  only global unicast `2000::/3` minus special-purpose carve-outs; IPv6 forms
  that embed an IPv4 address — IPv4-mapped, NAT64 and 6to4 — are judged by the
  embedded address). The exact ranges are listed in the
  [address policy](docs/backend-contract.md#address-policy). DNS is validated
  before each request and the socket is pinned to the validated addresses via
  the native `lookup` option of `node:http`/`node:https`
  (DNS-rebinding/TOCTOU protection). Public IPv6 literal URLs are supported.
- **Diagnosable failures**: connector errors return
  `502 Upstream connection failed [<code>].` instead of an opaque 500; an
  upstream deadline or Sharp processing timeout returns `504`; and the
  diagnostics page shows the server's error message
- **Upstream limits**: 8 s total fetch timeout (one deadline for DNS
  resolution, all hops and the body download; a stalled resolver is abandoned
  at the deadline and no request starts after it), 5 s socket inactivity
  timeout (resets on activity; a stall before the headers, between bytes or
  mid-body returns `504`), 15 MiB input, 6 MP input pixels (all frames
  counted together for animated input; an image above it returns `413`)
- **Upstream request headers**: fixed `Accept`, `User-Agent` and
  `Accept-Language` headers (never the client's, so a CDN that negotiates or
  sniffs on them cannot put one client's variant into the shared cache), plus
  the client's `DNT` and `Referer` (for hotlink protection). **Cookies are
  never forwarded.** `Referer` and `DNT` are not part of the CDN cache key, so a
  host that serves different images per `Referer` is cached by whichever request
  came first (see the
  [caching note](docs/backend-contract.md#caching))
- **Serverless processing defaults**: WebP quality 60; each
  Sharp/libvips pipeline has an 8 s processing timeout. Sharp excludes time
  waiting for a libuv worker, and this is a per-pipeline limit, not a whole-
  request deadline. Sharp uses `concurrency(1)` to limit libvips threads per
  image, not total concurrent function invocations. The Sharp cache and
  Node/libuv thread-pool defaults are unchanged.
- **Current encoder options**: WebP uses `effort: 4` and `smartSubsample: true`,
  plus `mixed: true` for animated input only (`minSize` is not used: it made
  animated encodes ~3× slower for the same size); JPEG uses progressive
  encoding, `mozjpeg: true`, and `4:2:0` chroma subsampling.
- **Allow-listed upstream response headers** (`etag`, `last-modified`,
  `expires`), forwarded only when the original bytes are returned unchanged
- **CORS support** for cross-origin requests, including
  `Access-Control-Expose-Headers` for the telemetry headers so CORS-bound
  callers can read them
- **Caching**: 24 h browser / 30 day Netlify CDN for every image response;
  `private, no-store` for every error; `Netlify-Vary` pins the cache key to
  the extension query params (the whole query for unencoded legacy URLs)
- **Telemetry headers**: `x-bh-*` plus legacy `x-original-size`,
  `x-compressed-size`, `x-bytes-saved`
- **Handshake response** (`bandwidth-hero-proxy`) for requests without a `url`
- **Health check endpoint** (`/api/health`) reporting Sharp status, version,
  API level and features
- **Built-in diagnostics page** with reachability, CORS/handshake, live image
  compression, and cache-header checks; checks that could not run are shown
  as "Skipped", and the header badge reflects the last run. Each request's
  deadline covers the response body, so a response that stalls after its
  headers is reported as a timeout instead of leaving the run hanging
- **Netlify Functions** deployment ready (esbuild; Sharp externalized).
  `netlify.toml` includes only `node_modules/sharp` (the JavaScript package)
  plus the two **Linux x64** native packages, `@img/sharp-linux-x64` and
  `@img/sharp-libvips-linux-x64`, because Netlify Node.js Functions run on
  Linux x86_64 here. It does **not** include the whole `node_modules/@img`
  tree. The ARM64 packages pinned in `package.json` exist so installs work on
  ARM64 machines; they are not packaged into the deployed function. This
  describes the configuration, not a measured artifact: before changing which
  native packages are included (for example if the runtime architecture ever
  changes), inspect the built function artifact.

## 🔌 API

```
GET /api/index?url=<encoded-image-url>[&quality=60|l=60][&bw=1][&jpeg=1][&max_width=0]
GET /api/health
```

Full contract (status codes, limits, headers):
[`docs/backend-contract.md`](docs/backend-contract.md).

---

## 🚀 Requirements

- **Node.js** ≥ 22.13.0 (`engines` in `package.json`); the Netlify deployment
  and the lockfile workflow pin Node.js **22.23.3** (`netlify.toml`,
  `.github/workflows/`)
- **Yarn Classic** 1.22.22 (`packageManager`; the repository's `yarn.lock` is
  the authoritative lockfile)
- **Runtime dependency** (exact-pinned): `sharp` 0.35.5, plus its native
  Linux x64/arm64 `@img` packages as `optionalDependencies` (these must stay
  enabled during installation). The current native libvips pins are 1.3.4 for
  both architectures. Only the x64 packages are included in the deployed
  Netlify function (see `netlify.toml`); the arm64 pins support installation
  on ARM64 Linux machines. Upstream fetching uses Node's standard-library
  `node:http`/`node:https`, so there is no HTTP-client dependency.
- **No dev dependencies**: `yarn start` / `yarn dev` run `netlify-cli`
  27.12.0 through `npx`, so CI and Netlify builds install only Sharp
  (`yarn.lock` has 32 entries)

> [!NOTE]
> When bumping `sharp`, bump the four `@img/sharp-*` pins in
> `optionalDependencies` to the versions that `sharp` itself declares, or the
> installed native binary will not match the JavaScript wrapper. CI enforces
> this with `yarn run check:sharp-pins` (`scripts/check-sharp-pins.mjs`),
> which fails the build if the pins drift from the installed `sharp`'s own
> `optionalDependencies`. Dependabot groups `sharp` and `@img/sharp-*` into
> one PR so bumps arrive together.

## 🧪 Testing

```bash
yarn install               # installs dependencies; yarn.lock remains authoritative
yarn test                  # all 76 tests across the six checked-in suites
yarn test:fast             # 36 network-free tests (address policy, handlers, health, diagnostics page)
yarn test:integration      # 40 Sharp/loopback tests (compression + request integration)
yarn run check             # full local gate (syntax check + Sharp native-pin check + all tests)
```

> [!IMPORTANT]
> Use `yarn run check`, not `yarn check`. `check` is a built-in Yarn Classic
> command (lockfile integrity check) and takes precedence over the script.

CI (`.github/workflows/ci.yml`) runs `yarn run check` on every pull request and
on pushes to `main`, using Node.js 22.23.3 and `yarn install --frozen-lockfile`.

The manual **Update Yarn lockfile** workflow opens its PR with the
`LOCKFILE_PR_TOKEN` secret when it is set (a fine-grained PAT or GitHub App
token). Without it, the PR is opened with `GITHUB_TOKEN`, which GitHub does not
let trigger other workflows, so run **CI** manually on that branch
(`workflow_dispatch`) before merging.

Suites:

| File | Scope |
|---|---|
| `tests/index.test.js` | Handshake, method handling, invalid URL and literal private-host rejection, shared response headers, integer query parsing, fallback-quality calculation, fallback-width generation, raw-query URL extraction (encoded, legacy unencoded, absent), `*.localhost` rejection, the legacy `1.1.x.x/bmi/` URL unwrap, and the rule for when the original may replace WebP output (including EXIF-rotated and multi-frame widths). No network or Sharp encoding. |
| `tests/health.test.js` | `/api/health`, method handling, and consistency of release version, API level, and feature metadata across `package.json`, `util/version.js`, and `docs/backend-contract.md`, plus a guard that every `tests/*.test.js` file is listed in the `package.json` test scripts (the scripts name files explicitly, so an unlisted suite would silently never run). |
| `tests/address-policy.test.js` | Every CIDR in both address-policy tables at its boundaries, IPv6 global-unicast edges, special-purpose fixtures, embedded-IPv4 forms, table-overlap checks, and malformed-address rejection. |
| `tests/site.test.js` | The diagnostics page (`site.js`) evaluated in a `node:vm` context with a minimal fake DOM and a scripted `fetch`, with timers shortened: a healthy run, a failing health check skipping the rest, the server's error message being shown, and response bodies that stall after the headers (handshake and health) ending as a timeout with the button re-enabled, plus a WCAG AA contrast check (4.5:1) of the status colours in both the dark and light themes. No browser, no network. |
| `tests/compress.test.js` | Adaptive fallback widths and real Sharp encodes, including tight caps for `max_width` 100, 320 and 800, JPEG fallback, large outputs, never-enlarge behavior, `413` when no width fits, undecodable input, truncated-JPEG tolerance, the bounded fallback encode count, and the request-budget `504`. |
| `tests/integration.test.js` | The handler against a local `node:http` server pinned via a test-only resolver: transparent JPEG flattening, animated-source passthrough, `quality=0`, `jpeg=true`, unsupported redirect schemes, the `508` redirect limit, redirects into private or local addresses (including IPv4-mapped IPv6) rejected with `403` by the real resolver and address policy on every hop after the first, `Referer` handling on same/cross-origin redirects, every `x-*` telemetry header being listed in `Access-Control-Expose-Headers`, fixed `Accept`/`User-Agent`/`Accept-Language` and no `Cookie` upstream, legacy and encoded raw-query URLs, upstream timeout and mid-body stall mapping, the `413` input-size limit, the `413` 6 MP decode limit (single-frame, exactly-at-limit and multi-frame), never-enlarge with detected type, never-enlarge honoring `bw=1` and `max_width` (including the EXIF-rotated width), non-browser formats staying WebP, and WebP telemetry headers. |

The six checked-in suites currently contain 76 tests: 36 in `test:fast` and
40 in `test:integration`.

The integration suite uses a small test-only configuration hook in
`functions/index.js` (`configureForTests`) to shorten the deadline and shrink
size limits. It requests `proxy.test`, which the test resolver pins to
`127.0.0.1`; using a literal loopback URL would correctly be rejected by the
production SSRF guard before the resolver is reached. Production defaults are
unchanged and the hook is not reachable from a request.

What the suites do **not** establish: a real HTTPS request (a trusted test
certificate would be needed; pinning uses the same `lookup` option for both
protocols), behavior against real internet hosts, rendering or CORS enforcement
in a real browser (the diagnostics page runs against a fake DOM), or real Netlify latency, peak
memory, cold-start time, deployment artifact size, and concurrent-load safety.
The integration suite currently covers the scenarios listed above. Redirects to
private targets are covered with literal addresses, so no DNS is involved; it
does not yet test DNS deadline edge cases or a hostname that resolves to a
private address on a later hop. Validate those
separately with a Deploy Preview and add focused regression tests when changing
those paths.

> [!NOTE]
> **SSRF & DNS Rebinding**: `resolveAndValidateRemoteUrl` resolves the hostname
> via DNS, rejects the request if any resolved address is private, and pins
> the outbound connection to exactly those validated addresses by passing a
> pinned `lookup` function to Node's native `http`/`https.request`
> (`requestPinned` in `functions/index.js`). This closes the standard
> DNS-rebinding TOCTOU gap: the socket can only ever connect to an address
> that was checked milliseconds earlier, and each redirect hop is
> re-resolved, re-checked, and re-pinned the same way. This is implemented
> with the Node standard library only — no third-party HTTP client — which
> also removes an entire class of bundling/runtime interop failures.

---

# Contributing Guidelines

Thank you for considering contributing to **Bandwidth Hero Proxy 2**! This
project is guided by a singular, focused mission:

> **"The easiest, most reliable, free, one-click deployable Bandwidth Hero
> proxy that anyone can deploy in minutes."**

## 🧭 Engineering Principles

Every proposed change or pull request should satisfy at least one of the
following criteria:
* **Makes deployment easier**: Reduces friction or setup steps for new users.
* **Improves reliability**: Hardens error handling, edge cases, timeouts, or
  security boundaries.
* **Improves compatibility**: Fixes issues with legacy/modern browser
  extensions or legitimate image CDNs.
* **Improves performance without increasing complexity**: Speeds up cold
  starts or reduces response latency without adding layers of abstractions.
* **Reduces maintenance burden**: Cleans up obsolete parameters, dead code, or
  refactors safely.

If a proposed change satisfies none of these, it will not be accepted.

### Implementation Preferences:
1. **Prefer simpler code** over clever abstractions.
2. **Prefer fewer dependencies** to keep the footprint tiny.
3. **Prefer backward compatibility** at all times to prevent breaking active
  client extensions.
4. **Prefer serverless-first solutions** matching free tier environments.
5. **Benchmark before optimizing**. Do not optimize based on assumptions.

---

## 📦 Dependency Policy

This project's greatest asset is its minimal size.
- **Justification**: Adding any third-party dependency requires clear
  justification and demonstration of a major benefit that cannot reasonably be
  achieved with Node's standard library.
- **Preference**: Removing or inlining custom utilities is preferred over
  adding packages.
- **Standard Library**: Always prefer native Node.js functionality (e.g.,
  `node:http`/`node:https`, global `Fetch API`, `AbortController`, `Buffer`)
  over third-party equivalents.

---

## 🏷️ Release Policy

- **Patch releases**: Strictly for bug fixes, security patches (e.g. SSRF
  updates), latency improvements, and internal code cleanups.
- **Minor releases**: Adding optional configuration features (e.g. environment
  variables), new diagnostic tools, or updating documentation.
- **Major releases**: Required only for breaking changes to:
  - The API boundaries.
  - Query parameter interfaces.
  - Base64/response format specifications.
  - Overall deployment processes.

Every release must update `package.json`, `util/version.js`,
`docs/backend-contract.md`, and `CHANGELOG.md` together. The current tests check
that `package.json`, `util/version.js`, and `docs/backend-contract.md` agree on
the version and feature metadata; they do not validate changelog contents, so
add the changelog entry as part of the same change. Only record changes that
can be verified; do not reconstruct history from memory.

---

## 🔗 Related projects (not part of this repository)

The projects below are maintained separately and are **not** part of this repository, its build pipeline, or its release cycle. They are listed here for convenience only.

### 🧩 Bandwidth Guardian

[Bandwidth Guardian](https://github.com/anT0ny54/bandwidth-guardian) is the
Chromium extension this proxy is built for. It rewrites image URLs to
`/api/index?url=<encoded>&jpeg=0&bw=<0|1>&quality=<1-100>[&max_width=<px>]`
and reads the `x-bh-*` telemetry headers for its statistics. Its **Test**
button checks the handshake and also reads `/api/health` (version, API level
and Sharp status) next to the configured proxy URL.

### 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns.mydoh.workers.dev/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` |

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
