const proxyPath = "/api/index";
const proxyUrl = `${window.location.origin}${proxyPath}`;
const $ = (id) => document.getElementById(id);

$("proxy-url").textContent = proxyUrl;

const diagnostics = [
  ["reachable", "Proxy reachable"],
  ["cors", "CORS + handshake"],
  ["compression", "Image compression"],
  ["cache", "Caching headers"],
];

function setStatus(id, state, detail = "") {
  const status = $(`${id}-status`);
  const metric = $(`${id}-metric`);
  const icon = $(`${id}-icon`);
  status.className = `state ${state}`;
  status.textContent = state === "ok" ? "Passed" : state === "fail" ? "Failed" : "Pending";
  metric.textContent = detail;
  icon.textContent = state === "ok" ? "✓" : state === "fail" ? "!" : "•";
}

function resetStatuses() {
  for (const [id] of diagnostics) setStatus(id, "pending", "");
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function runDiagnostics() {
  const button = $("diagnostics-button");
  resetStatuses();
  button.disabled = true;
  button.textContent = "Running…";

  try {
    const health = await fetchWithTimeout("/api/health");
    let data = null;
    try { data = await health.json(); } catch {}
    const healthOk = health.ok && data?.status === "ok";
    const sharpOk = data?.sharp?.available === true;

    setStatus(
      "reachable",
      healthOk ? "ok" : "fail",
      healthOk ? `API ${data.version ?? "unknown"} · ${data.service ?? "proxy"}` : `HTTP ${health.status}`
    );

    if (healthOk && !sharpOk) {
      setStatus("compression", "fail", `Sharp unavailable: ${data?.sharp?.error || "runtime module missing"}`);
    }

    if (!healthOk) {
      for (const [id] of diagnostics.slice(1)) setStatus(id, "fail", "Diagnostics stopped");
      return;
    }

    const handshake = await fetchWithTimeout(proxyPath);
    const body = (await handshake.text()).trim();
    const corsOk = handshake.ok &&
      body === "bandwidth-hero-proxy" &&
      handshake.headers.get("access-control-allow-origin") === "*";
    setStatus("cors", corsOk ? "ok" : "fail", corsOk ? "Handshake and CORS verified" : `HTTP ${handshake.status}`);

    if (!corsOk) {
      setStatus("compression", "fail", "Handshake check failed");
      setStatus("cache", "fail", "Handshake check failed");
      return;
    }

    // GitHub's public avatar is intentionally fetched by the proxy, not by this page.
    const sample = "https://avatars.githubusercontent.com/u/9919";
    const started = performance.now();
    const image = await fetchWithTimeout(`${proxyPath}?url=${encodeURIComponent(sample)}`);
    const elapsed = Math.round(performance.now() - started);
    const type = image.headers.get("content-type") || "";
    const original = Number(image.headers.get("x-bh-original-size") || 0);
    const saved = Number(image.headers.get("x-bh-bytes-saved") || 0);
    const ratio = original > 0 ? `${((saved / original) * 100).toFixed(1)}% saved` : "size telemetry unavailable";
    const compressedOk = image.ok && type.startsWith("image/") && original > 0;
    setStatus("compression", compressedOk ? "ok" : "fail", compressedOk ? `${type} · ${elapsed} ms · ${ratio}` : `HTTP ${image.status}`);

    const cache = image.headers.get("cache-control") || "";
    const cacheOk = /^public,/i.test(cache);
    setStatus("cache", cacheOk ? "ok" : "fail", cacheOk ? "Browser/CDN cache headers verified" : "Public Cache-Control header missing");
  } catch (error) {
    const detail = error?.name === "AbortError" ? "Request timed out" : "Connection or CORS error";
    setStatus("reachable", "fail", detail);
    for (const [id] of diagnostics.slice(1)) setStatus(id, "fail", "Diagnostics stopped");
  } finally {
    button.disabled = false;
    button.textContent = "Run diagnostics again";
  }
}

$("diagnostics-button").addEventListener("click", runDiagnostics);
$("copy-button").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(proxyUrl);
    $("copy-button").textContent = "Copied ✓";
    setTimeout(() => $("copy-button").textContent = "Copy URL", 1400);
  } catch {
    $("copy-button").textContent = "Copy unavailable";
    setTimeout(() => $("copy-button").textContent = "Copy URL", 1400);
  }
});
