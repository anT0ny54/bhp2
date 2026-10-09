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

- **WebP output** by default (best compression)
- **JPEG output** with `jpeg=1` (mozjpeg, progressive)
- **Grayscale conversion** with `bw=1`
- **Quality control**: `quality` (1–100, default 60) plus legacy alias `l`
- **Maximum-width resizing** (`max_width`, 0 = no limit, capped at 8192; never
  enlarges)
- **EXIF auto-orientation**; metadata is stripped from re-encoded output
- **Animated-image passthrough**: when JPEG output is requested, multi-frame
  GIF/WebP/TIFF sources are returned untouched (detected from the bytes even
  if the upstream omitted `Content-Type`). If those bytes exceed the 4.3 MB
  response target the request fails with a clear `413` instead of an opaque
  gateway error. WebP output keeps animation.
- **Never-enlarge guarantee**: original bytes are returned (with format
  detection when the upstream omitted `Content-Type`) if compression would
  grow the file
- **Adaptive output fallback**: quality, then width, are progressively reduced
  to stay under Netlify's 6 MB buffered response limit (4.3 MB binary safety
  target). Fallback widths are always strictly below a requested `max_width`
  and continue down to 16 px, so even small limits (for example
  `max_width=100`) still have narrower sizes to try; images are never enlarged
- **Manual redirect handling**: bounded at 5 hops; every hop is re-resolved,
  re-validated and re-pinned; `Cookie`/`Referer` are stripped on cross-origin
  hops
- **SSRF protection**: HTTP/HTTPS-only URLs; an explicit, table-driven
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
  `502 Upstream connection failed [<code>].` instead of an opaque 500, an
  upstream that stalls past the deadline returns `504`, and the diagnostics
  page shows the server's error message
- **Upstream limits**: 8 s total fetch timeout (one deadline for DNS
  resolution, all hops and the body download; a stalled resolver is abandoned
  at the deadline and no request starts after it), 15 MiB input, 24 MP input
  pixels
- **Serverless processing defaults**: WebP quality 60 and `effort: 4`; Sharp
  uses `concurrency(1)` to limit libvips threads per image, not total concurrent
  function invocations. The Sharp cache and Node/libuv thread-pool defaults are
  unchanged.
- **Current encoder options**: WebP uses `smartSubsample: true`, `minSize: true`,
  and `mixed: true`; JPEG uses progressive encoding, `mozjpeg: true`, and
  `4:2:0` chroma subsampling.
- **Allow-listed upstream response headers** (`etag`, `last-modified`,
  `expires`), forwarded only when the original bytes are returned unchanged
- **CORS support** for cross-origin requests
- **Caching**: 24 h browser / 30 day Netlify CDN for public responses;
  `private, no-store` for cookie-bearing requests and for every error;
  `Netlify-Vary` pins the cache key to the extension query params
- **Telemetry headers**: `x-bh-*` plus legacy `x-original-size`,
  `x-compressed-size`, `x-bytes-saved`
- **Handshake response** (`bandwidth-hero-proxy`) for requests without a `url`
- **Health check endpoint** (`/api/health`) reporting Sharp status, version,
  API level and features
- **Built-in diagnostics page** with reachability, CORS/handshake, live image
  compression, and cache-header checks
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
- **Dev dependency**: `netlify-cli` for local development (`yarn dev` /
  `yarn start`)

> [!NOTE]
> When bumping `sharp`, bump the four `@img/sharp-*` pins in
> `optionalDependencies` to the versions that `sharp` itself declares, or the
> installed native binary will not match the JavaScript wrapper.

## 🧪 Testing

```bash
yarn install               # installs dependencies; keeps yarn.lock in sync
yarn test                  # every suite below (82 tests)
yarn test:fast             # network-free suites only (33 tests, well under a second)
yarn test:integration      # Sharp + local-server suites (49 tests, roughly 15 s)
yarn run check             # full local gate (syntax validation + all tests), same as CI
```

> [!IMPORTANT]
> Use `yarn run check`, not `yarn check`. `check` is a built-in Yarn Classic
> command (lockfile integrity check) and takes precedence over the script.

CI (`.github/workflows/ci.yml`) runs `yarn run check` on every pull request and
on pushes to `main`, using Node.js 22.23.3 and `yarn install --frozen-lockfile`.

Suites:

| File | Scope |
|---|---|
| `tests/index.test.js` | Handler behavior (handshake, CORS, 405, URL/host rejection), URL parsing, pinned lookup, DNS validation, and the DNS step's handling of the shared deadline. No network, no Sharp. |
| `tests/health.test.js` | `/api/health` plus version/feature consistency across `package.json`, `util/version.js` and `docs/backend-contract.md`. |
| `tests/address-policy.test.js` | Every CIDR in both address-policy tables at its boundaries (first/last address inside, neighbours outside), IPv6 global-unicast edges, IANA special-purpose fixtures, embedded-IPv4 forms, and fail-closed handling of malformed input. |
| `tests/compress.test.js` | Adaptive fallback widths and `compressImage` with real Sharp encodes, including regression tests for `max_width` 100, 320 and 800, JPEG output, never-enlarge and the `413` case. |
| `tests/integration.test.js` | The full handler against local `node:http` servers: WebP/JPEG output, grayscale, resizing, animation preservation, original-bytes fallback and headers, redirects (same-origin, cross-origin credential stripping, private targets, redirect limit), socket pinning, input-size limits, malformed/truncated images, upstream errors, and the shared 8 s deadline (slow body, stalled DNS, DNS stalling mid-redirect-chain, late DNS answers, accumulated slow hops). |

The integration suites use a small test-only configuration hook in
`functions/index.js` (`configureForTests`) to shorten the deadline and shrink
size limits, and a test resolver that maps validated test hostnames to
`127.0.0.1`. Production defaults are unchanged and the hook is not reachable
from a request.

What the suites do **not** establish: HTTPS requests (a trusted test
certificate would be needed; the pinning mechanism is the same `lookup` option
for both protocols), behavior against real internet hosts, and real Netlify
latency, peak memory, cold-start time, deployment artifact size or
concurrent-load safety. Validate those separately with a Deploy Preview.

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

## 🌐 Free DNS Services

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
