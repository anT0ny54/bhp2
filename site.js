const proxyPath = "/api/index";
const proxyUrl = `${window.location.origin}${proxyPath}`;
const $ = (id) => document.getElementById(id);

$("proxy-url").textContent = proxyUrl;

// Display labels live in index.html; only the element-id prefixes are needed here.
const diagnostics = ["reachable", "cors", "compression", "cache"];

// state: "pending" | "ok" | "fail" | "skip" (not run because an earlier check failed).
const STATE_LABELS = { pending: "Pending", ok: "Passed", fail: "Failed", skip: "Skipped" };
const STATE_ICONS = { pending: "•", ok: "✓", fail: "!", skip: "–" };

function setStatus(id, state, detail = "") {
  $(`${id}-status`).className = `state ${state}`;
  $(`${id}-status`).textContent = STATE_LABELS[state];
  $(`${id}-metric`).textContent = detail;
  $(`${id}-icon`).textContent = STATE_ICONS[state];
}

function hasState(id, state) {
  return $(`${id}-status`).classList.contains(state);
}

// The header badge reflects the last diagnostics run instead of claiming
// "online" unconditionally.
function setBadge(state, text) {
  $("status-badge").className = `badge ${state}`;
  $("status-badge-text").textContent = text;
}

function resetStatuses() {
  for (const id of diagnostics) setStatus(id, "pending", "");
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
  setBadge("pending", "Checking…");
  button.disabled = true;
  button.textContent = "Running…";

  try {
    const health = await fetchWithTimeout("/api/health");
    let data = null;
    try { data = await health.json(); } catch {}
    const healthOk = health.ok && data?.status === "ok";
    const sharpOk = data?.sharp?.available === true;
    const sharpError = `Sharp unavailable: ${data?.sharp?.error || "runtime module missing"}`;

    setStatus(
      "reachable",
      healthOk ? "ok" : "fail",
      healthOk ? `v${data.version ?? "?"} · API ${data.api ?? "?"} · ${data.service ?? "proxy"}` : `HTTP ${health.status}`
    );
    setBadge(healthOk ? "ok" : "fail", healthOk ? "Proxy online" : "Proxy unreachable");

    if (!healthOk) {
      for (const id of diagnostics.slice(1)) setStatus(id, "skip", "Health check failed");
      return;
    }

    if (!sharpOk) setStatus("compression", "fail", sharpError);

    const handshake = await fetchWithTimeout(proxyPath);
    const body = (await handshake.text()).trim();
    const corsOk = handshake.ok &&
      body === "bandwidth-hero-proxy" &&
      handshake.headers.get("access-control-allow-origin") === "*";
    setStatus("cors", corsOk ? "ok" : "fail", corsOk ? "Handshake and CORS verified" : `HTTP ${handshake.status}`);

    if (!corsOk) {
      // Keep a Sharp failure already reported by the health check.
      if (sharpOk) setStatus("compression", "skip", "Handshake check failed");
      setStatus("cache", "skip", "Handshake check failed");
      return;
    }

    // GitHub's public avatar is intentionally fetched by the proxy, not by this page.
    const sample = "https://avatars.githubusercontent.com/u/9919";
    const started = performance.now();
    // The server's own upstream deadline is 8 s, so give this request more
    // headroom than that; otherwise the page aborts first and can never show
    // the server's 504 message.
    const image = await fetchWithTimeout(`${proxyPath}?url=${encodeURIComponent(sample)}`, {}, 15000);
    const elapsed = Math.round(performance.now() - started);
    const type = image.headers.get("content-type") || "";
    const original = Number(image.headers.get("x-bh-original-size") || 0);
    const saved = Number(image.headers.get("x-bh-bytes-saved") || 0);
    const ratio = original > 0 ? `${((saved / original) * 100).toFixed(1)}% saved` : "size telemetry unavailable";
    const compressedOk = image.ok && type.startsWith("image/") && original > 0;
    // On failure, surface the server's error body so a broken upstream path
    // is diagnosable straight from the diagnostics panel.
    let compressionDetail = `HTTP ${image.status}`;
    if (!compressedOk) {
      try {
        const serverMessage = (await image.text()).trim().slice(0, 160);
        if (serverMessage) compressionDetail = `HTTP ${image.status}: ${serverMessage}`;
      } catch {}
    }
    setStatus(
      "compression",
      compressedOk ? "ok" : "fail",
      compressedOk ? `${type} · ${elapsed} ms · ${ratio}` : sharpOk ? compressionDetail : sharpError
    );

    // Error responses are deliberately private/no-store, so the cache check
    // is only meaningful for a successful image response.
    if (!compressedOk) {
      setStatus("cache", "skip", "Image check failed");
      return;
    }
    const cache = image.headers.get("cache-control") || "";
    const cacheOk = /^public,/i.test(cache);
    setStatus("cache", cacheOk ? "ok" : "fail", cacheOk ? "Browser/CDN cache headers verified" : "Public Cache-Control header missing");
  } catch (error) {
    const detail = error?.name === "AbortError" ? "Request timed out" : "Connection or CORS error";
    // Results already shown (passed checks, or a failure such as "Sharp
    // unavailable") are kept. Only the first unfinished check reports this
    // error, and only if nothing has failed yet; the rest were never run.
    let failureShown = diagnostics.some((id) => hasState(id, "fail"));
    for (const id of diagnostics) {
      if (!hasState(id, "pending")) continue;
      if (failureShown) {
        setStatus(id, "skip", "Diagnostics stopped");
        continue;
      }
      setStatus(id, "fail", detail);
      failureShown = true;
      if (id === "reachable") setBadge("fail", "Proxy unreachable");
    }
  } finally {
    button.disabled = false;
    button.textContent = "Run diagnostics again";
  }
}

function flashCopyLabel(text) {
  $("copy-button").textContent = text;
  setTimeout(() => { $("copy-button").textContent = "Copy URL"; }, 1400);
}

$("diagnostics-button").addEventListener("click", runDiagnostics);
$("copy-button").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(proxyUrl);
    flashCopyLabel("Copied ✓");
  } catch {
    flashCopyLabel("Copy unavailable");
  }
});
