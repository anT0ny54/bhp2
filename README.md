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

## 🔒 Recommended DNS Configuration

For optimal security and ad-blocking, configure your DNS with **My Free DNS**:

| Blocklist | DNS-over-HTTPS Endpoint |
|-----------|------------------------|
| **HaGeZi Multi Pro + TIF** | `https://freedns.koyeb.app/dns-query` ✅ |
| **HaGeZi Multi Pro + TIF** | `https://freedns-six.vercel.app/api/doh/dns-query` ✅ |
| **HaGeZi Multi Pro + TIF** | `https://dnssix.netlify.app/api/doh/dns-query` |

---

## 🎯 Live Demo

Check out a working example of Bandwidth Hero Server in action: [bhserv.netlify.app](https://bhserv.netlify.app/)

---

## 💝 Support This Project

If you'd like to support the development, donations are appreciated:

**Bitcoin:** `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

---


## 2.2.6 optimization profile

- WebP uses Sharp effort 6 for smaller output and enables animated-WebP `minSize`/`mixed` optimization.
- Equivalent upstream URLs with URL fragments share one proxy/cache key because HTTP fragments are not transmitted to the origin.
- Successful public image responses are browser-cacheable for 24 hours and edge-cacheable for 30 days with stale-while-revalidate.
- The binary safety target is 4.3 MB to stay below Netlify's ~4.5 MB effective buffered binary ceiling after Base64 overhead.

## 2.2.7 maintenance pass

- `PROXY_VERSION`/`API_VERSION`/`FEATURES` now live in one place (`util/version.js`) instead of being hand-copied into `functions/index.js`, `functions/health.js`, and `package.json` — the drift between those files that happened in both 2.2.4 and 2.2.6 can't recur silently, and a test now asserts they stay in sync.
- Upstream request headers are built once per request instead of being rebuilt on every redirect hop.
- No query parameters, response headers, or client-visible behavior changed.
