# ⚡ Bandwidth Hero Server (bhp2)

A lightweight, serverless image-compression proxy for Bandwidth Hero-compatible
browser extensions (e.g. Bandwidth Guardian).

The service fetches remote images, converts them to WebP or JPEG using Sharp,
optionally applies grayscale conversion and maximum-width resizing, and
delivers optimized versions to dramatically reduce bandwidth usage. It ships
with a mobile-friendly diagnostics page (`index.html` + `site.js` + `site.css`)
and a JSON health endpoint (`/api/health`).

🖮️ **Live Demo:** [Bandwidth Hero](https://bhp2.netlify.app/)

📋 **Changelog:** [CHANGELOG.md](CHANGELOG.md) ·
**API contract:** [docs/backend-contract.md](docs/backend-contract.md)

---

## ✨ Features (verified against the code)

- **WebP output** by default (best compression)
- **JPEG output** with `jpeg=1` parameter
- **Grayscale conversion** with `bw=1` parameter
- **Quality control**: `quality` (1–100, default 60) plus legacy alias `l`
- **Maximum-width resizing** (`max_width`, 0 = no limit, capped at 8192)
- **Animated-image passthrough**: multi-frame GIF/WebP/TIFF sources are
  returned untouched when JPEG output is requested
- **Never-enlarge guarantee**: original bytes are returned (with format
  detection when the upstream omitted `Content-Type`) if compression would
  grow the file
- **Adaptive output fallback**: quality, then width, are progressively reduced
  to stay under Netlify's 6 MB buffered response limit (4.3 MB binary safety
  target)
- **Manual redirect handling**: bounded at 5 hops; every hop is re-resolved,
  re-validated and re-pinned; credentials stripped on cross-origin hops
- **SSRF protection**: HTTP/HTTPS-only URLs; private/loopback/link-local/
  CGNAT/multicast/reserved IPv4 **and** IPv6 blocking; DNS validated before
  each request and the socket pinned to the validated addresses via the
  native `lookup` option of `node:http`/`node:https` (DNS-rebinding/TOCTOU
  protection)
- **Diagnosable failures**: connector errors return
  `502 Upstream connection failed [<code>].` instead of an opaque 500, and the
  diagnostics page shows the server's error message
- **Upstream limits**: 8 s total fetch timeout (one deadline for all hops and
  the body download), 15 MB input, 40 MP input pixels
- **Allow-listed upstream response headers** (`etag`, `last-modified`,
  `expires`)
- **CORS support** for cross-origin requests
- **Caching**: 24 h browser / 30 day Netlify CDN for public responses;
  `private, no-store` for cookie-bearing requests; `Netlify-Vary` pins the
  cache key to the extension query params
- **Telemetry headers**: `x-bh-*` plus legacy `x-original-size`,
  `x-compressed-size`, `x-bytes-saved`
- **Handshake response** (`bandwidth-hero-proxy`) for requests without a `url`
- **Health check endpoint** (`/api/health`) reporting Sharp status, version,
  API level and features
- **Built-in diagnostics page** with reachability, CORS/handshake, live image
  compression, and cache-header checks
- **Netlify Functions** deployment ready (esbuild; Sharp externalized with
  native `@img` packages included)

## 🔌 API

```
GET /api/index?url=<encoded-image-url>[&quality=60|l=60][&bw=1][&jpeg=1][&max_width=0]
GET /api/health
```

Full contract: [`docs/backend-contract.md`](docs/backend-contract.md).

---

## 🚀 Requirements

- **Node.js** ≥ 22.13.0 (`engines` in `package.json`); the Netlify deployment
  pins Node.js **22.23.3** (`netlify.toml`)
- **Yarn Classic** 1.22.22 (`packageManager`; the repository's `yarn.lock` is
  the authoritative lockfile)
- **Dependencies** (exact-pinned): `sharp` 0.35.5 only — upstream fetching
  uses Node's standard-library `node:http`/`node:https`
- **Netlify CLI** for local development (`yarn dev` / `yarn start`)

## 🧪 Testing

```bash
yarn install     # regenerate yarn.lock after the undici removal
yarn test        # node --test tests/index.test.js tests/health.test.js
yarn check       # full local gate (syntax validation + tests), identical to CI
```

Coverage of the current suites (all network-free):

- **Compatibility tests**: the `bandwidth-hero-proxy` handshake, CORS
  preflight, and 405 handling.
- **Security tests**: host validation blocks (SSRF) — loopback, RFC1918,
  link-local, CGNAT, IETF-reserved (192.0.0.0/24) and IPv6 private ranges;
  URL parser acceptance/rejection; DNS pin lookup behavior.
- **Consistency tests**: `package.json`, `util/version.js` and `/api/health`
  report the same version; shared CORS/security headers are present on health
  responses.

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
`docs/backend-contract.md`, and `CHANGELOG.md` together.

---

## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not use in 15 minute) |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not use in 15 minute) |

---

# ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:
- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`
