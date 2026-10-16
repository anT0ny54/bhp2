import { PROXY_VERSION, API_VERSION, FEATURES } from "../util/version.js";
import { createResponse } from "../util/headers.js";

const NO_STORE = { "cache-control": "no-store" };

export async function handler(event = {}) {
  const method = event.httpMethod || "GET";
  if (method === "OPTIONS") {
    return createResponse(204, "", NO_STORE);
  }
  if (method !== "GET") {
    // Error responses are plain text per docs/backend-contract.md, matching
    // the main proxy handler instead of returning a JSON body here.
    return createResponse(405, "Method Not Allowed", {
      allow: "GET, OPTIONS",
      "content-type": "text/plain; charset=utf-8",
      ...NO_STORE,
    });
  }

  let sharpStatus;
  try {
    const module = await import("sharp");
    const sharp = module.default || module;
    sharpStatus = {
      available: true,
      version: sharp.versions?.sharp || "unknown",
      libvips: sharp.versions?.vips || "unknown",
    };
  } catch (error) {
    sharpStatus = {
      available: false,
      error: error?.message || "Unable to load Sharp",
    };
  }

  return createResponse(
    200,
    JSON.stringify({
      status: "ok",
      service: "bandwidth-hero-proxy",
      version: PROXY_VERSION,
      api: Number(API_VERSION),
      sharp: sharpStatus,
      features: FEATURES,
    }),
    { "content-type": "application/json; charset=utf-8", ...NO_STORE },
  );
}
