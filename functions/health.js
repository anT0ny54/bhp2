const VERSION = "2.2.2";
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "x-content-type-options": "nosniff",
};

export async function handler(event = {}) {
  const method = event.httpMethod || "GET";
  if (method === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (method !== "GET") {
    return {
      statusCode: 405,
      headers: { ...HEADERS, allow: "GET, OPTIONS" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let sharpStatus = { available: false };
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

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      status: "ok",
      service: "bandwidth-hero-proxy",
      version: VERSION,
      api: 1,
      sharp: sharpStatus,
      features: ["webp", "grayscale", "maxwidth", "stats"],
    }),
  };
}
