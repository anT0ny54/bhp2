# ⚡ Bandwidth Hero Server

A lightweight, serverless image-compression proxy for Bandwidth Hero-compatible browser extensions.

The service fetches remote images, converts them to WebP or JPEG using Sharp, optionally applies grayscale conversion and resizing, and delivers optimized versions to dramatically reduce bandwidth usage and improve loading performance.

---

## ✨ Features

- **WebP output** by default (best compression)
- **JPEG output** with `jpeg=1` parameter
- **Grayscale conversion** with `bw=1` parameter
- **Quality control** for fine-tuned optimization
- **Maximum-width resizing** for responsive images
- **Manual redirect handling** with configurable redirect limits
- **URL validation** for HTTP and HTTPS
- **Private IP blocking** (IPv4 and IPv6)
- **DNS resolution checks** before each request
- **DNS-rebinding protection** for security
- **Image-size limits** to prevent abuse
- **Sharp pixel limits** for memory efficiency
- **CORS support** for cross-origin requests
- **Health check endpoint** (`/api/health`)
- **Node.js native test runner** for testing
- **Netlify Functions deployment** ready

---

## 🚀 Requirements

- **Node.js** 22.13 or later (project deployment pins Node.js 22.23.2)
- **Yarn Classic** 1.22.22 (the repository's `yarn.lock` is the authoritative lockfile)
- **Netlify CLI** for local development
- **Sharp** for image processing

---

# Contributing Guidelines

Thank you for considering contributing to **Bandwidth Hero Proxy 2**! This project is guided by a singular, focused mission:

> **"The easiest, most reliable, free, one-click deployable Bandwidth Hero proxy that anyone can deploy in minutes."**

---

## 🧭 Engineering Principles

Every proposed change or pull request should satisfy at least one of the following criteria:
* **Makes deployment easier**: Reduces friction or setup steps for new users.
* **Improves reliability**: Hardens error handling, edge cases, timeouts, or security boundaries.
* **Improves compatibility**: Fixes issues with legacy/modern browser extensions or legitimate image CDNs.
* **Improves performance without increasing complexity**: Speeds up cold starts or reduces response latency without adding layers of abstractions.
* **Reduces maintenance burden**: Cleans up obsolete parameters, dead code, or refactors safely.

If a proposed change satisfies none of these, it will not be accepted.

### Implementation Preferences:
1. **Prefer simpler code** over clever abstractions.
2. **Prefer fewer dependencies** to keep the footprint tiny.
3. **Prefer backward compatibility** at all times to prevent breaking active client extensions.
4. **Prefer serverless-first solutions** matching free tier environments.
5. **Benchmark before optimizing**. Do not optimize based on assumptions.

---

## 📦 Dependency Policy

This project's greatest asset is its minimal size. 
- **Justification**: Adding any third-party dependency requires clear justification and demonstration of a major benefit that cannot reasonably be achieved with Node's standard library.
- **Preference**: Removing or inlining custom utilities is preferred over adding packages.
- **Standard Library**: Always prefer native Node.js functionality (e.g., global `Fetch API`, `AbortController`, `Buffer`) over third-party equivalents.

---

## 🏷️ Release Policy

- **Patch releases**: Strictly for bug fixes, security patches (e.g. SSRF updates), latency improvements, and internal code cleanups.
- **Minor releases**: Adding optional configuration features (e.g. environment variables), new diagnostic tools, or updating documentation.
- **Major releases**: Required only for breaking changes to:
  - The API boundaries.
  - Query parameter interfaces.
  - Base64/response format specifications.
  - Overall deployment processes.

---

## 🧪 Testing Guidelines

Before opening a PR, ensure all tests pass:
```bash
npm test
```

All contributions that alter request handling or add features must include tests matching one of these categories:
- **Compatibility tests**: Validate that legacy and modern extension requests behave identically.
- **Security tests**: Test host validation blocks (SSRF) and redirect traversal filters.
- **Image pipeline tests**: Verify aspect-ratio resizing, grayscale output, and formats.

> [!NOTE]
> **SSRF & DNS Rebinding**: `resolveAndValidateRemoteUrl` resolves the hostname via DNS, rejects the request if any resolved address is private, and pins the outbound connection to exactly those validated addresses via an `undici` `Agent` with a custom `connect.lookup` (`createPinnedDispatcher` in `functions/index.js`). This closes the standard DNS-rebinding TOCTOU gap: Node's built-in `fetch()` ignores the legacy `http(s).Agent` option and always re-resolves the hostname itself at connect time, so a check performed beforehand doesn't otherwise constrain where the connection actually goes. Each redirect hop is re-resolved, re-checked, and re-pinned the same way. This is the one accepted exception to the Dependency Policy's "no new dependencies" preference above: there is no supported way to pin a `fetch()` connection using only Node's standard library, so `undici` — the library that already powers `fetch()` internally — is a direct dependency for this specific purpose.

## 🔒 Recommended DNS Configuration

For ad/tracker blocking alongside this proxy, you can point your device or
browser at a DNS-over-HTTPS resolver running the **HaGeZi Multi Pro + TIF**
blocklist via **My Free DNS**. The same blocklist is mirrored at three
independent endpoints — pick whichever is fastest/most reliable from your
network; they're interchangeable, not tiered:

- `https://freedns.koyeb.app/dns-query`
- `https://freedns-six.vercel.app/api/doh/dns-query`
- `https://dnssix.netlify.app/api/doh/dns-query
- `https://dns-93aca.containers.snapdeploy.app/dns-query`

This is unrelated to the proxy's own DNS-rebinding protection (see
[`docs/backend-contract.md`](docs/backend-contract.md#security)), which
always applies regardless of which resolver your client uses.

---

## 🎯 Live Demo

Check out a working example of Bandwidth Hero Server in action: [bhserv.netlify.app](https://bhserv.netlify.app/)

---

## 💝 Support This Project

If you'd like to support the development, donations are appreciated:

**Bitcoin:** `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

---


## 📋 Release history

Current version: **2.2.8**. Full release notes for every version live in
[`CHANGELOG.md`](CHANGELOG.md) — kept there only, not duplicated here, since
maintaining the same version history in two files is exactly the kind of
drift that caused the version-string bug fixed in 2.2.4 and again in 2.2.7.

For the full API contract (query parameters, response headers, caching and
security behavior), see [`docs/backend-contract.md`](docs/backend-contract.md).
