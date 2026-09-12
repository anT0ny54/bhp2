import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import sharp from "sharp";

import {
  handler,
} from "../functions/index.js";

import {
  isPrivateHost,
  isPrivateIp,
  resetDnsLookupForTests,
  setDnsLookupForTests,
  validateRemoteUrl,
  resolveAndValidateRemoteUrl,
} from "../util/validate.js";

let originalFetch;
let testImage;

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

test("supports JPEG output", async () => {
  usePublicDnsForTests();

  global.fetch = async () =>
    mockImageResponse();

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
