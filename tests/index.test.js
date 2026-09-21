import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, mock, test } from "node:test";

import sharp from "sharp";

import { Agent } from "undici";

import {
  handler,
} from "../functions/index.js";
import { handler as healthHandler } from "../functions/health.js";
import { PROXY_VERSION } from "../util/version.js";

import {
  isPrivateHost,
  isPrivateIp,
  resetDnsLookupForTests,
  setDnsLookupForTests,
  validateRemoteUrl,
  resolveAndValidateRemoteUrl,
  createPinnedLookup,
} from "../util/validate.js";

let originalFetch;
let testImage;
let photoLikeImage;

// A flat solid color is a worst-case input for lossy formats: PNG's lossless
// deflate shrinks it to nearly nothing, while JPEG/WebP still pay their
// fixed container/table overhead, so lossy output can legitimately end up
// *larger* than the PNG for such trivial content. Real-world "does this
// image compress smaller" tests need pixel content with actual photographic
// variance. This generates one deterministically (fixed seed, no external
// fixture file) so the test suite stays hermetic and reproducible.
function makePhotoLikePixels(width, height) {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      pixels[i] = Math.min(255, Math.floor((x / width) * 255 + next() * 40));
      pixels[i + 1] = Math.min(255, Math.floor((y / height) * 255 + next() * 40));
      pixels[i + 2] = Math.min(255, Math.floor(((x + y) / (width + height)) * 255 + next() * 40));
    }
  }
  return pixels;
}

before(async () => {
  originalFetch = global.fetch;

  testImage = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: {
        r: 255,
        g: 0,
        b: 0,
      },
    },
  })
    .png()
    .toBuffer();

  photoLikeImage = await sharp(makePhotoLikePixels(128, 128), {
    raw: { width: 128, height: 128, channels: 3 },
  })
    .png()
    .toBuffer();
});

after(() => {
  global.fetch = originalFetch;
  resetDnsLookupForTests();
});

function mockImageResponse(buffer = testImage) {
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(buffer.length),
      etag: '"test-image"',
    },
  });
}

function mockRedirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
    },
  });
}

function makeEvent(query = {}, headers = {}) {
  return {
    httpMethod: "GET",
    headers,
    queryStringParameters: query,
  };
}

function usePublicDnsForTests() {
  setDnsLookupForTests(async () => [
    {
      address: "93.184.216.34",
      family: 4,
    },
  ]);
}

test("returns the compatibility handshake without a URL", async () => {
  const response = await handler(
    makeEvent()
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "bandwidth-hero-proxy");
  assert.equal(
    response.headers["content-type"],
    "text/plain; charset=utf-8"
  );
});

test("rejects malformed URLs with status 400", async () => {
  const response = await handler(
    makeEvent({
      url: "not-a-valid-url",
    })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.body,
    "Invalid URL. Only HTTP and HTTPS URLs are supported."
  );
  assert.equal(
    response.headers["cache-control"],
    "private, no-store"
  );
});

test("rejects unsupported URL protocols", async () => {
  const response = await handler(
    makeEvent({
      url: "file:///etc/passwd",
    })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.body,
    "Invalid URL. Only HTTP and HTTPS URLs are supported."
  );
});

test("rejects localhost", async () => {
  const response = await handler(
    makeEvent({
      url: "http://localhost/test.jpg",
    })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.body,
    "Requests to private or local addresses are not allowed."
  );
});

test("rejects private IPv4 addresses", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("169.254.1.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("rejects private IPv6 addresses", () => {
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::"), true);
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fd12:3456::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("2001:4860:4860::8888"), false);
});

test("rejects IPv4-mapped IPv6 private addresses", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("rejects private hostnames and accepts public hostnames", () => {
  assert.equal(isPrivateHost("localhost"), true);
  assert.equal(isPrivateHost("127.0.0.1"), true);
  assert.equal(isPrivateHost("[::1]"), true);
  assert.equal(isPrivateHost("example.com"), false);
});

test("validates HTTP and HTTPS URLs", () => {
  assert.equal(
    validateRemoteUrl("https://example.com/image.jpg").valid,
    true
  );

  assert.equal(
    validateRemoteUrl("ftp://example.com/image.jpg").valid,
    false
  );
});

test("blocks DNS resolution to private addresses", async () => {
  setDnsLookupForTests(async () => [
    {
      address: "127.0.0.1",
      family: 4,
    },
  ]);

  const result = await resolveAndValidateRemoteUrl(
    "https://attacker-controlled.example/image.jpg"
  );

  assert.equal(result.valid, false);
  assert.equal(
    result.error,
    "Requests to private or local addresses are not allowed."
  );
});

test("blocks DNS rebinding when any returned address is private", async () => {
  setDnsLookupForTests(async () => [
    {
      address: "93.184.216.34",
      family: 4,
    },
    {
      address: "10.0.0.10",
      family: 4,
    },
  ]);

  const result = await resolveAndValidateRemoteUrl(
    "https://rebind.example/image.jpg"
  );

  assert.equal(result.valid, false);
  assert.equal(
    result.error,
    "Requests to private or local addresses are not allowed."
  );
});

test("allows a hostname resolving only to public addresses", async () => {
  usePublicDnsForTests();

  const result = await resolveAndValidateRemoteUrl(
    "https://cdn.example/image.jpg"
  );

  assert.equal(result.valid, true);
  assert.equal(
    result.url,
    "https://cdn.example/image.jpg"
  );
});

test("resolveAndValidateRemoteUrl exposes the validated addresses for pinning", async () => {
  setDnsLookupForTests(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2001:db8::1", family: 6 },
  ]);

  const result = await resolveAndValidateRemoteUrl(
    "https://cdn.example/image.jpg"
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.addresses, [
    { address: "93.184.216.34", family: 4 },
    { address: "2001:db8::1", family: 6 },
  ]);
});

test("createPinnedLookup always answers with the pinned addresses, never a live query", async () => {
  const lookup = createPinnedLookup([
    { address: "93.184.216.34", family: 4 },
    { address: "2001:db8::1", family: 6 },
  ]);

  await new Promise((resolve, reject) => {
    lookup("attacker-controlled.example", { all: true }, (err, addresses) => {
      try {
        assert.equal(err, null);
        assert.deepEqual(addresses, [
          { address: "93.184.216.34", family: 4 },
          { address: "2001:db8::1", family: 6 },
        ]);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });

  await new Promise((resolve, reject) => {
    lookup("attacker-controlled.example", { family: 6 }, (err, address, family) => {
      try {
        assert.equal(err, null);
        assert.equal(address, "2001:db8::1");
        assert.equal(family, 6);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});

test("pins the outbound fetch to a dispatcher built from the validated addresses", async () => {
  usePublicDnsForTests();

  let capturedDispatcher;
  global.fetch = async (url, options) => {
    capturedDispatcher = options?.dispatcher;
    return mockImageResponse();
  };

  const response = await handler(
    makeEvent({ url: "https://cdn.example/image.jpg" })
  );

  assert.equal(response.statusCode, 200);
  assert.ok(
    capturedDispatcher instanceof Agent,
    "expected fetch to be called with an undici Agent dispatcher pinned to the validated addresses"
  );
});

test("follows relative redirects", async () => {
  usePublicDnsForTests();

  global.fetch = async (url) => {
    if (url === "https://cdn.example/start.jpg") {
      return mockRedirectResponse("/image.jpg");
    }

    if (url === "https://cdn.example/image.jpg") {
      return mockImageResponse();
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/start.jpg",
    })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.isBase64Encoded, true);
  assert.equal(
    response.headers["content-type"],
    "image/webp"
  );
});

test("blocks redirects to private addresses", async () => {
  usePublicDnsForTests();

  global.fetch = async (url) => {
    if (url === "https://cdn.example/start.jpg") {
      return mockRedirectResponse(
        "http://127.0.0.1:8080/admin"
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/start.jpg",
    })
  );

  assert.equal(response.statusCode, 403);
  assert.equal(
    response.body,
    "Requests to private or local addresses are not allowed."
  );
});

test("enforces the redirect limit", async () => {
  usePublicDnsForTests();

  global.fetch = async (url) =>
    mockRedirectResponse(url);

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/loop.jpg",
    })
  );

  assert.equal(response.statusCode, 508);
  assert.equal(
    response.body,
    "Too many upstream redirects."
  );
});

test("compresses an image and returns protocol headers", async () => {
  usePublicDnsForTests();

  global.fetch = async () =>
    mockImageResponse();

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/image.png",
      quality: "40",
    })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.isBase64Encoded, true);
  assert.equal(
    response.headers["content-type"],
    "image/webp"
  );

  assert.match(
    response.headers["x-bh-version"],
    /^\d+\.\d+\.\d+$/
  );

  assert.equal(
    response.headers["x-bh-backend"],
    "bandwidth-proxy-2"
  );

  assert.equal(
    response.headers["x-bh-api"],
    "1"
  );

  assert.equal(
    response.headers["x-bh-features"],
    "webp,grayscale,maxwidth,stats"
  );

  assert.ok(
    Number(response.headers["x-bh-original-size"]) > 0
  );

  assert.ok(
    Number(response.headers["x-bh-compressed-size"]) > 0
  );

  assert.ok(
    Number(response.headers["x-bh-bytes-saved"]) >= 0
  );

  assert.equal(
    response.headers["x-original-size"],
    response.headers["x-bh-original-size"]
  );

  assert.equal(
    response.headers["x-bytes-saved"],
    response.headers["x-bh-bytes-saved"]
  );
});

test("keeps the proxy version in sync across package.json, health, and image responses", async () => {
  // This project has drifted before: functions/health.js reported an older
  // version than functions/index.js after a hand-copied string wasn't
  // updated in both places (see CHANGELOG 2.2.4 and 2.2.6). PROXY_VERSION is
  // now defined once in util/version.js and imported everywhere, but this
  // test still guards package.json specifically, since that value can't be
  // imported by the same mechanism and has to be kept in sync by hand.
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.version, PROXY_VERSION);

  const health = await healthHandler({ httpMethod: "GET" });
  const healthBody = JSON.parse(health.body);
  assert.equal(healthBody.version, PROXY_VERSION);

  usePublicDnsForTests();
  global.fetch = async () => mockImageResponse();
  const response = await handler(makeEvent({ url: "https://cdn.example/image.png" }));
  assert.equal(response.headers["x-bh-version"], PROXY_VERSION);
});

test("does not publicly cache requests containing cookies", async () => {
  usePublicDnsForTests();

  let receivedHeaders;

  global.fetch = async (url, options) => {
    receivedHeaders = options.headers;
    return mockImageResponse();
  };

  const response = await handler(
    makeEvent(
      {
        url: "https://cdn.example/private-image.png",
      },
      {
        cookie: "session=secret-value",
      }
    )
  );

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["cache-control"],
    "private, no-store"
  );

  assert.equal(
    receivedHeaders.cookie,
    "session=secret-value"
  );
});

test("uses public caching for requests without cookies", async () => {
  usePublicDnsForTests();

  global.fetch = async () =>
    mockImageResponse();

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/public-image.png",
    })
  );

  assert.equal(response.statusCode, 200);
  assert.match(
    response.headers["cache-control"],
    /^public,/
  );
});



test("accepts case-insensitive request headers", async () => {
  usePublicDnsForTests();

  let receivedHeaders;
  global.fetch = async (url, options) => {
    receivedHeaders = options.headers;
    return mockImageResponse();
  };

  const response = await handler(
    makeEvent(
      { url: "https://cdn.example/case.png" },
      {
        Cookie: "session=secret-value",
        "User-Agent": "TestBrowser/1.0",
      },
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(receivedHeaders.cookie, "session=secret-value");
  assert.equal(receivedHeaders["user-agent"], "TestBrowser/1.0");
});


test("preserves the original media type when compression is larger", async () => {
  usePublicDnsForTests();

  // A 1x1 PNG is already near the format's minimum size. JPEG's fixed
  // container overhead (JFIF header, Huffman/quantization tables) reliably
  // exceeds that for any image this trivial, regardless of the installed
  // libjpeg/mozjpeg minor version — unlike comparing against WebP, where an
  // encoder's small-file heuristics (e.g. `minSize`) can vary the outcome
  // between versions. Requesting `jpeg: "1"` keeps this test's outcome tied
  // to that structural fact instead of an incidental encoder byte count.
  const tinyPng = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).png().toBuffer();

  global.fetch = async () =>
    new Response(tinyPng, {
      status: 200,
      headers: { "content-type": "image/png" },
    });

  const response = await handler(
    makeEvent({ url: "https://cdn.example/tiny.png", jpeg: "1" }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["x-original-size"], response.headers["x-compressed-size"]);
});

test("detects the original media type when upstream omits Content-Type", async () => {
  usePublicDnsForTests();

  // See the previous test for why `jpeg: "1"` is used against a 1x1 PNG.
  const tinyPng = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).png().toBuffer();

  global.fetch = async () =>
    new Response(tinyPng, { status: 200 });

  const response = await handler(
    makeEvent({ url: "https://cdn.example/tiny-no-type", jpeg: "1" }),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["x-original-size"], response.headers["x-compressed-size"]);
});

test("supports JPEG output", async () => {
  usePublicDnsForTests();

  // A photo-like fixture is used here (rather than the flat-color
  // `testImage`) because a solid color is a worst case for lossy formats:
  // PNG's lossless deflate shrinks it to near nothing, while JPEG still pays
  // its fixed table/header overhead, so JPEG output can legitimately end up
  // larger than the PNG for such trivial content — that's exactly what the
  // "preserves the original media type" tests above verify. This test wants
  // the ordinary case, where JPEG compression actually reduces size.
  global.fetch = async () =>
    mockImageResponse(photoLikeImage);

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/image.png",
      jpeg: "1",
    })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["content-type"],
    "image/jpeg"
  );
});

test("supports grayscale output", async () => {
  usePublicDnsForTests();

  global.fetch = async () =>
    mockImageResponse();

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/image.png",
      bw: "1",
    })
  );

  assert.equal(response.statusCode, 200);
});

test("supports the legacy l quality parameter", async () => {
  usePublicDnsForTests();

  global.fetch = async () =>
    mockImageResponse();

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/image.png",
      l: "70",
    })
  );

  assert.equal(response.statusCode, 200);
});

test("rejects non-image upstream responses", async () => {
  usePublicDnsForTests();

  global.fetch = async () =>
    new Response("not an image", {
      status: 200,
      headers: {
        "content-type": "text/html",
      },
    });

  const response = await handler(
    makeEvent({
      url: "https://cdn.example/page.html",
    })
  );

  assert.equal(response.statusCode, 415);
  assert.equal(
    response.body,
    "Upstream returned a non-image response (text/html)."
  );
});

test("rejects IPv6 site-local, NAT64 and 6to4 addresses embedding private targets", () => {
  assert.equal(isPrivateIp("fec0::1"), true);
  assert.equal(isPrivateIp("64:ff9b::7f00:1"), true);
  assert.equal(isPrivateIp("64:ff9b::808:808"), false);
  assert.equal(isPrivateIp("2002:c0a8:101::1"), true);
  assert.equal(isPrivateIp("2002:0808:0808::1"), false);
});

test("drops cookies on cross-origin redirects but keeps them same-origin", async () => {
  usePublicDnsForTests();
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push([url, options.headers.cookie]);
    if (url === "https://cdn.example/a.jpg") return mockRedirectResponse("/b.jpg");
    if (url === "https://cdn.example/b.jpg") return mockRedirectResponse("https://other.example/c.jpg");
    return mockImageResponse();
  };

  const response = await handler(
    makeEvent({ url: "https://cdn.example/a.jpg" }, { cookie: "sid=secret" })
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, [
    ["https://cdn.example/a.jpg", "sid=secret"],
    ["https://cdn.example/b.jpg", "sid=secret"],
    ["https://other.example/c.jpg", undefined],
  ]);
});

test("returns 502 for an invalid upstream redirect location", async () => {
  usePublicDnsForTests();
  global.fetch = async () => mockRedirectResponse("http://[bad");

  const response = await handler(makeEvent({ url: "https://cdn.example/a.jpg" }));
  assert.equal(response.statusCode, 502);
});

test("times out when the upstream body stalls after headers arrive", async (t) => {
  usePublicDnsForTests();
  t.mock.timers.enable({ apis: ["setTimeout"] });

  global.fetch = async (url, options) => {
    const body = new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError"))
        );
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
  };

  const pending = handler(makeEvent({ url: "https://cdn.example/slow.png" }));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8_000);
  const response = await pending;

  assert.equal(response.statusCode, 504);
});
