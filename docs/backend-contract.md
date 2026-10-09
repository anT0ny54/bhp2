# Bandwidth Proxy 2 — Backend Contract

**Version:** 2.2.14  
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
| `quality` | `60` | Compression quality, 1–100 |
| `l` | `60` | Legacy alias for `quality` |
| `bw` | `0` | `1` enables grayscale |
| `jpeg` | `0` | `1` requests JPEG; otherwise WebP |
| `max_width` | `0` | Resize limit in pixels; 0 means no requested limit |

No existing parameter was removed or renamed.

A request without `url` is the legacy handshake: `200` with the plain-text body
`bandwidth-hero-proxy` and `Cache-Control: public, max-age=300`.

Non-numeric `quality`/`max_width` values fall back to their defaults; numeric
values are clamped (`quality` 1–100, `max_width` 0–8192).

## Limits

| Limit | Value |
|---|---|
| Upstream fetch deadline (all redirect hops + body download) | 8 s |
| Redirects followed | 5 |
| Source image size | 15 MB |
| Source image pixels | 24 MP |
| Response size target (before base64) | 4.3 MB |

## Serverless image-processing defaults

- Sharp WebP uses `effort: 4` to favor response time over maximum compression effort.
- Sharp uses `concurrency(1)` to keep per-image native thread usage predictable; this does not cap concurrent function invocations.
- Input decoding is limited to 24 MP by default. Increase only after measuring peak memory and concurrent-request behavior on a Netlify deploy preview.
- Sharp cache and Node/libuv thread-pool defaults are unchanged until benchmarks show they are a bottleneck.

These are conservative defaults, not measured performance guarantees. Validate with representative JPEG, PNG, WebP, and animated inputs before production rollout.

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
X-BH-Version: 2.2.14
X-BH-Api: 1
X-BH-Features: webp,grayscale,maxwidth,stats
X-BH-Original-Size: <bytes>
X-BH-Compressed-Size: <bytes>
X-BH-Bytes-Saved: <bytes>
X-Original-Size: <bytes>
X-Compressed-Size: <bytes>
X-Bytes-Saved: <bytes>
```

When `jpeg=1` is requested and the source is a multi-frame GIF/WebP/TIFF
(detected from the bytes even if the upstream omitted `Content-Type`), the
original animated bytes are returned unmodified, because JPEG cannot carry
animation. If those bytes exceed the 4.3 MB response target, the request fails
with `413` rather than producing a response Netlify would reject.

If compression would make the representation larger, the original image bytes
are returned instead and compressed/original size are equal. If the upstream
omitted `Content-Type`, the fallback path detects the original image format
before returning it so the response never labels original bytes as WebP/JPEG.

## Error responses

Errors are plain text with an appropriate status code, always carrying
`Cache-Control: private, no-store`. Connector-level failures (the upstream
could not be reached at all) return
`502 Upstream connection failed [<code>].` with the underlying error code, so
a broken deployment is diagnosable from the response body.

### Status codes

| Status | Meaning |
|---:|---|
| 200 | Image, or the handshake when `url` is absent |
| 204 | CORS preflight (`OPTIONS`) |
| 400 | `url` is not a valid HTTP/HTTPS URL, or is a literal private/local host |
| 403 | Hostname resolved to a private address, or a redirect led to a private address |
| 405 | Method other than `GET`/`OPTIONS` (`Allow: GET, OPTIONS`) |
| 413 | Source above 15 MB, optimized output cannot fit the response target, or original bytes above the target would have to be returned unmodified |
| 415 | Upstream explicitly returned a non-image `Content-Type` |
| 4xx/5xx | Upstream error statuses are passed through |
| 500 | Other processing failure (for example, undecodable image data) |
| 502 | DNS failure, upstream connection failure `[<code>]`, or invalid redirect |
| 503 | Sharp is unavailable on the runtime |
| 504 | Upstream deadline exceeded (including a stalled body download) |
| 508 | More than 5 redirects |

## Security

- Only HTTP and HTTPS URLs are accepted.
- Localhost, loopback, RFC1918, link-local, CGNAT, multicast and other private
  address ranges are rejected.
- DNS answers are resolved and checked before every upstream request, and the
  outbound connection is pinned to exactly those validated addresses via the
  `lookup` option of Node's native `http`/`https.request`, so a hostname can't
  rebind to a private address between the check and the connection.
- Redirect destinations are re-resolved, re-checked, and re-pinned the same
  way before each hop is fetched.
- Cookie and Referer request headers are stripped when a redirect crosses
  origins; same-origin redirects keep them for compatibility.
- IPv6 addresses that embed an IPv4 address (IPv4-compatible `::a.b.c.d`,
  IPv4-mapped, NAT64 and 6to4) are judged by the embedded IPv4 address.
- Upstream response headers are allow-listed (`etag`, `last-modified`,
  `expires`) and are forwarded only when the original bytes are returned; a
  re-encoded image is a new representation and gets none of them.
- Cookie-bearing requests use private, no-store caching.

## Caching

Public requests use a 24-hour browser cache and a 30-day Netlify CDN cache:

```text
Cache-Control: public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800
Netlify-CDN-Cache-Control: public, durable, s-maxage=2592000, stale-while-revalidate=604800
Netlify-Vary: query=url|quality|bw|jpeg|max_width|l
```

Cookie-bearing requests use `private, no-store`.

## Netlify deployment

The project uses esbuild bundling and explicitly externalizes Sharp while
including its native `@img` packages. Sharp optional dependencies must remain
enabled during installation. Upstream fetches use only Node standard-library
modules (`node:http` / `node:https`).

Netlify's buffered synchronous function responses are limited to 6 MB. Because
binary Lambda-style responses are base64 encoded (~30% overhead), this build
keeps optimized image output below a 4.3 MB binary safety target when
necessary. Normal images are unaffected; only oversized outputs enter the
adaptive quality/resize fallback.
