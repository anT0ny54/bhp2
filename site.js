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

// One deadline covers the response headers AND the body read: `read` runs
// before the timer is cleared. Clearing it as soon as the headers arrived let
// a body that stalled afterwards hang the run with the button stuck on
// "Running…". Aborting mid-body rejects with AbortError, handled below.
async function fetchWithTimeout(url, read, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return { response, body: await read(response) };
  } finally {
    clearTimeout(timer);
  }
}

const isAbort = (error) => error?.name === "AbortError";
// A malformed body is a normal failed check (null); only a timeout propagates.
const readJson = (response) => response.json().catch((error) => { if (isAbort(error)) throw error; return null; });
const readText = (response) => response.text();

function readImageTelemetry(response) {
  const readSize = (name, allowZero = false) => {
    const raw = response.headers.get(name);
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0) ? value : null;
  };
  const original = readSize("x-bh-original-size");
  const compressed = readSize("x-bh-compressed-size");
  const saved = readSize("x-bh-bytes-saved", true);
  if (original === null || compressed === null || saved === null) return null;
  return saved === Math.max(0, original - compressed) ? { original, saved } : null;
}

async function readImageCheck(response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (response.ok && contentType.startsWith("image/")) {
    // Diagnostics needs only headers. Never download an image as an error body
    // just because its telemetry is absent or inconsistent.
    const telemetry = readImageTelemetry(response);
    await response.body?.cancel();
    return {
      telemetry,
      message: telemetry ? "" : "Image telemetry headers are missing or inconsistent.",
    };
  }

  try {
    return { telemetry: null, message: (await response.text()).trim().slice(0, 160) };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { telemetry: null, message: "" };
  }
}

async function runDiagnostics() {
  const button = $("diagnostics-button");
  resetStatuses();
  setBadge("pending", "Checking…");
  button.disabled = true;
  button.textContent = "Running…";

  try {
    const { response: health, body: data } = await fetchWithTimeout("/api/health", readJson);
    const healthOk = health.ok && data?.status === "ok";
    const sharpOk = data?.sharp?.available === true;
    const sharpError = `Sharp unavailable: ${data?.sharp?.error || "runtime module missing"}`;

    setStatus(
      "reachable",
      healthOk ? "ok" : "fail",
      healthOk ? `v${data.version ?? "?"} · API ${data.api ?? "?"} · ${data.service ?? "proxy"}` : `HTTP ${health.status}`
    );
    // Image compression is the proxy's purpose, so a proxy without Sharp is not "online".
    if (!healthOk) setBadge("fail", "Proxy unreachable");
    else if (!sharpOk) setBadge("fail", "Compression unavailable");

    if (!healthOk) {
      for (const id of diagnostics.slice(1)) setStatus(id, "skip", "Health check failed");
      return;
    }

    if (!sharpOk) setStatus("compression", "fail", sharpError);

    const { response: handshake, body: handshakeBody } = await fetchWithTimeout(proxyPath, readText);
    const corsOk = handshake.ok &&
      handshakeBody.trim() === "bandwidth-hero-proxy" &&
      handshake.headers.get("access-control-allow-origin") === "*";
    setStatus("cors", corsOk ? "ok" : "fail", corsOk ? "Handshake and CORS verified" : `HTTP ${handshake.status}`);

    if (!corsOk) {
      // Keep a Sharp failure already reported by the health check.
      if (sharpOk) {
        setStatus("compression", "skip", "Handshake check failed");
        setBadge("fail", "API handshake failed");
      }
      setStatus("cache", "skip", "Handshake check failed");
      return;
    }

    // A health response that reports missing Sharp is already a definitive
    // compression failure; do not send a second image request that could
    // overwrite that result if the module happens to recover mid-run.
    if (!sharpOk) {
      setStatus("cache", "skip", "Compression unavailable");
      return;
    }

    // GitHub's public avatar is intentionally fetched by the proxy, not by this page.
    const sample = "https://avatars.githubusercontent.com/u/9919";
    const started = performance.now();
    // The server's own upstream deadline is 8 s, so give this request more
    // headroom than that; otherwise the page aborts first and can never show
    // the server's 504 message.
    const { response: image, body: imageCheck } = await fetchWithTimeout(
      `${proxyPath}?url=${encodeURIComponent(sample)}`,
      readImageCheck,
      15000,
    );
    const elapsed = Math.round(performance.now() - started);
    const telemetry = imageCheck.telemetry;
    const compressedOk = telemetry !== null;
    const compressionDetail = imageCheck.message
      ? `HTTP ${image.status}: ${imageCheck.message}`
      : `HTTP ${image.status}`;

    let successDetail = "";
    if (compressedOk) {
      const type = image.headers.get("content-type") || "";
      successDetail = `${type} · ${elapsed} ms · ${((telemetry.saved / telemetry.original) * 100).toFixed(1)}% saved`;
    }

    setStatus(
      "compression",
      compressedOk ? "ok" : "fail",
      compressedOk ? successDetail : sharpOk ? compressionDetail : sharpError
    );

    // Error responses are deliberately private/no-store, so the cache check
    // is only meaningful for a successful image response.
    if (!compressedOk) {
      setStatus("cache", "skip", "Image check failed");
      setBadge("fail", "Compression check failed");
      return;
    }
    const cache = image.headers.get("cache-control") || "";
    const cacheOk = /^public,/i.test(cache);
    setStatus("cache", cacheOk ? "ok" : "fail", cacheOk ? "Public Cache-Control directive present" : "Cache-Control is not public");
    setBadge(cacheOk ? "ok" : "fail", cacheOk ? "Proxy online" : "Cache check failed");
  } catch (error) {
    const detail = isAbort(error) ? "Request timed out" : "Connection or CORS error";
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
      const badgeText = {
        reachable: "Proxy unreachable",
        cors: "API handshake failed",
        compression: "Compression check failed",
        cache: "Cache check failed",
      }[id];
      setBadge("fail", badgeText);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Run diagnostics again";
  }
}

let copyLabelTimer;
let copyRequestId = 0;
function clearCopyLabelTimer() {
  if (copyLabelTimer !== undefined) clearTimeout(copyLabelTimer);
  copyLabelTimer = undefined;
}
function flashCopyLabel(text, requestId) {
  clearCopyLabelTimer();
  $("copy-button").textContent = text;
  copyLabelTimer = setTimeout(() => {
    // clearTimeout cannot retract a callback that has already entered the
    // task queue. Ignore stale resets so an older click cannot overwrite the
    // feedback for a newer clipboard request.
    if (requestId !== copyRequestId) return;
    $("copy-button").textContent = "Copy URL";
    copyLabelTimer = undefined;
  }, 1400);
}

$("diagnostics-button").addEventListener("click", runDiagnostics);
$("copy-button").addEventListener("click", async () => {
  // Clipboard writes can settle out of order. Only the latest click may change
  // the feedback label, just as only its timer may reset that label.
  const requestId = ++copyRequestId;
  clearCopyLabelTimer();
  $("copy-button").textContent = "Copying…";
  try {
    await navigator.clipboard.writeText(proxyUrl);
    if (requestId !== copyRequestId) return;
    flashCopyLabel("Copied ✓", requestId);
  } catch {
    if (requestId !== copyRequestId) return;
    flashCopyLabel("Copy unavailable", requestId);
  }
});
