const VERSION = "2.0.1";
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
  if (method !== "GET") return { statusCode: 405, headers: { ...HEADERS, allow: "GET, OPTIONS" }, body: JSON.stringify({ error: "Method Not Allowed" }) };

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      status: "ok",
      service: "bandwidth-hero-proxy",
      version: VERSION,
      api: 1,
      features: ["webp", "grayscale", "maxwidth", "stats"],
    }),
  };
}
