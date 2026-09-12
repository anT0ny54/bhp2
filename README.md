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
