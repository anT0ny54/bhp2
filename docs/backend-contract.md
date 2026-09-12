# Bandwidth Proxy 2 — Backend Contract

**Version:** 2.2.3  
**API:** 1  
**Status:** Stable

## Endpoint

`GET /api/index`

The endpoint accepts a URL-encoded upstream image and returns a compressed
WebP/JPEG image. `GET /api/health` provides a lightweight compatibility check.

## Query parameters

| Parameter | Default | Description |
|---|---:|---|
| `url` | — | Full HTTP/HTTPS upstream image URL |
| `quality` | `40` | Compression quality, 1–100 |
| `l` | `40` | Legacy alias for `quality` |
| `bw` | `0` | `1` enables grayscale |
| `jpeg` | `0` | `1` requests JPEG; otherwise WebP |
| `max_width` | `0` | Resize limit in pixels; 0 means no requested limit |

No existing parameter was removed or renamed.

## Compatibility

The proxy preserves:

- `bandwidth-hero-proxy` no-URL handshake
- `quality` and `l`
- `jpeg=1` and `bw=1`
- relative upstream redirects
- legacy `x-original-size`, `x-compressed-size`, `x-bytes-saved`
- `x-bh-*` telemetry headers

These are the parameters and response conventions used by Bandwidth Guardian
and Bandwidth Hero MV3. The current Bandwidth Guardian implementation builds
proxy URLs with `url`, `jpeg`, `bw`, `quality`, and optional `max_width`, and
uses the telemetry headers for statistics.

## Successful image response

```text
HTTP/1.1 200 OK
Content-Type: image/webp
Content-Encoding: identity
X-BH-Backend: bandwidth-proxy-2
X-BH-Version: 2.2.1
X-BH-Api: 1
X-BH-Features: webp,grayscale,maxwidth,stats
X-BH-Original-Size: <bytes>
X-BH-Compressed-Size: <bytes>
X-BH-Bytes-Saved: <bytes>
X-Original-Size: <bytes>
X-Compressed-Size: <bytes>
X-Bytes-Saved: <bytes>
```

If compression would make the representation larger, the original image bytes
are returned instead and compressed/original size are equal. If the upstream
omitted `Content-Type`, the fallback path detects the original image format
before returning it so the response never labels original bytes as WebP/JPEG.

## Security

- Only HTTP and HTTPS URLs are accepted.
- Localhost, loopback, RFC1918, link-local, CGNAT, multicast and other private
  address ranges are rejected.
- DNS answers are checked before every upstream request.
- Redirect destinations are validated again before fetching.
- Upstream response headers are allow-listed.
- Cookie-bearing requests use private, no-store caching.

## Caching

Public requests use a one-hour browser cache and a seven-day Netlify CDN cache:

```text
Cache-Control: public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400
Netlify-CDN-Cache-Control: public, durable, s-maxage=604800, stale-while-revalidate=86400
Netlify-Vary: query=url|quality|bw|jpeg|max_width|l
```

Cookie-bearing requests use `private, no-store`.

## Netlify deployment

The project uses esbuild bundling and explicitly externalizes Sharp while
including its native `@img` packages. Sharp optional dependencies must remain
enabled during installation.

Netlify's buffered synchronous function responses are limited to 6 MB. Because
binary Lambda-style responses are base64 encoded, this build keeps optimized
image output below a 4.4 MB binary safety target when necessary. Normal images
are unaffected; only oversized outputs enter the adaptive quality/resize
fallback.
