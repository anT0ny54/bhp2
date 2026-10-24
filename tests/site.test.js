// Diagnostics-page tests (network-free). site.js is a classic browser script,
// so it is evaluated in a vm context with a minimal fake DOM and a scripted
// fetch(). setTimeout is shortened so the page's 8 s / 15 s deadlines elapse
// in milliseconds; the production script is not modified in any way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../site.js", import.meta.url), "utf8");

function createElement() {
  const element = {
    textContent: "",
    className: "",
    disabled: false,
    listeners: {},
    classList: { contains: (name) => element.className.split(/\s+/).includes(name) },
    addEventListener(type, listener) { element.listeners[type] = listener; },
  };
  return element;
}

// spec: { status = 200, headers, body, stallBody }. A stalled body never
// settles on its own; it rejects with AbortError only when the page aborts it,
// like a real fetch() body stream.
function makeResponse(spec, signal) {
  const status = spec.status ?? 200;
  const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = () => spec.stallBody
    ? new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
    : Promise.resolve(spec.body ?? "");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: { cancel: async () => {} },
    text: async () => String(await body()),
    json: async () => JSON.parse(await body()),
  };
}

function loadPage(route, options = {}) {
  const {
    writeClipboard = async () => {},
    timerSet = (callback, ms) => setTimeout(callback, Math.min(ms, 25)),
    timerClear = clearTimeout,
  } = options;
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  vm.runInNewContext(source, {
    window: { location: { origin: "https://proxy.test" } },
    document: { getElementById: get },
    navigator: { clipboard: { writeText: writeClipboard } },
    performance,
    AbortController,
    clearTimeout: timerClear,
    setTimeout: timerSet,
    fetch: async (url, { signal }) => makeResponse(route(url), signal),
  });
  return {
    run: () => get("diagnostics-button").listeners.click(),
    state: (id) => get(`${id}-status`).textContent,
    detail: (id) => get(`${id}-metric`).textContent,
    badge: () => get("status-badge-text").textContent,
    button: () => get("diagnostics-button"),
    copy: () => get("copy-button").listeners.click(),
    copyLabel: () => get("copy-button").textContent,
  };
}

const HEALTHY = {
  "/api/health": {
    body: JSON.stringify({ status: "ok", version: "9.9.9", api: 1, service: "bandwidth-hero-proxy", sharp: { available: true } }),
  },
  handshake: { headers: { "access-control-allow-origin": "*" }, body: "bandwidth-hero-proxy\n" },
  image: {
    headers: {
      "content-type": "image/webp",
      "x-bh-original-size": "1000",
      "x-bh-bytes-saved": "400",
      "cache-control": "public, max-age=86400",
    },
  },
};

function router(overrides = {}) {
  const table = { ...HEALTHY, ...overrides };
  return (url) => {
    if (url === "/api/health") return table["/api/health"];
    if (url === "/api/index") return table.handshake;
    return table.image;
  };
}

test("diagnostics pass for a healthy proxy and re-enable the button", async () => {
  const page = loadPage(router());
  await page.run();
  for (const id of ["reachable", "cors", "compression", "cache"]) assert.equal(page.state(id), "Passed", id);
  assert.match(page.detail("reachable"), /v9\.9\.9 · API 1/);
  assert.match(page.detail("compression"), /image\/webp · \d+ ms · 40\.0% saved/);
  assert.equal(page.badge(), "Proxy online");
  assert.equal(page.button().disabled, false);
  assert.equal(page.button().textContent, "Run diagnostics again");
});

test("a failing health check skips every later check", async () => {
  const page = loadPage(router({ "/api/health": { status: 502, body: "bad gateway" } }));
  await page.run();
  assert.equal(page.state("reachable"), "Failed");
  assert.equal(page.detail("reachable"), "HTTP 502");
  for (const id of ["cors", "compression", "cache"]) assert.equal(page.state(id), "Skipped", id);
  assert.equal(page.badge(), "Proxy unreachable");
});

test("the server's error message is shown when compression fails; cache check is skipped", async () => {
  const page = loadPage(router({ image: { status: 504, body: "Upstream image request timed out." } }));
  await page.run();
  assert.equal(page.state("compression"), "Failed");
  assert.equal(page.detail("compression"), "HTTP 504: Upstream image request timed out.");
  assert.equal(page.state("cache"), "Skipped");
});

// These two hung forever before the deadline covered the body read: the timer
// was cleared as soon as the headers arrived. The test timeout turns a
// regression into a failure instead of a stuck run.
test("a handshake body that stalls after the headers times out instead of hanging", { timeout: 3_000 }, async () => {
  const page = loadPage(router({ handshake: { headers: { "access-control-allow-origin": "*" }, stallBody: true } }));
  await page.run();
  assert.equal(page.state("reachable"), "Passed");
  assert.equal(page.state("cors"), "Failed");
  assert.equal(page.detail("cors"), "Request timed out");
  assert.equal(page.state("compression"), "Skipped");
  assert.equal(page.state("cache"), "Skipped");
  assert.equal(page.button().disabled, false);
});

test("a health body that stalls after the headers reports a timeout, not a bad response", { timeout: 3_000 }, async () => {
  const page = loadPage(router({ "/api/health": { stallBody: true } }));
  await page.run();
  assert.equal(page.state("reachable"), "Failed");
  assert.equal(page.detail("reachable"), "Request timed out");
  assert.equal(page.badge(), "Proxy unreachable");
  assert.equal(page.button().disabled, false);
});

// WCAG 2.x contrast for every text colour, against each surface it is drawn on.
// The light theme once inherited the dark theme's --danger (2.7:1 on white),
// and --accent / --muted were later found below 4.5:1 on the page background
// and the primary button, which this test originally did not look at.
test("text colours keep AA contrast (4.5:1) on their surfaces in both themes", () => {
  const css = readFileSync(new URL("../site.css", import.meta.url), "utf8");
  // Accepts #rgb and #rrggbb (the light theme uses #fff for --surface-strong).
  const expand = (hex) => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex);
  const tokens = (block) => Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*(#(?:[0-9a-f]{3}|[0-9a-f]{6}))\b/gi)].map((m) => [m[1], expand(m[2])]),
  );
  const dark = tokens(css.match(/:root\s*\{([^}]*)\}/)[1]);
  const light = { ...dark, ...tokens(css.match(/prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/)[1]) };
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  assert.equal(light["surface-strong"], "#ffffff", "light theme tokens must be parsed, not inherited from dark");
  // [text token, surface tokens it is drawn on]. Cards and status rows use
  // surface-strong; the lead text, eyebrow, links and footer sit directly on the
  // page gradient (bg to bg2); the primary button label sits on the accent fill.
  const page = ["bg", "bg2"];
  const pairs = [
    ["text", ["surface-strong", ...page]],
    ["muted", ["surface-strong", ...page]],
    ["accent", ["surface-strong", ...page]],
    ["accent-2", ["surface-strong"]],
    ["danger", ["surface-strong"]],
    ["on-accent", ["accent"]],
  ];
  for (const [name, theme] of [["dark", dark], ["light", light]]) {
    for (const [token, surfaces] of pairs) {
      assert.ok(theme[token], `${name} theme defines no --${token}`);
      for (const surface of surfaces) {
        const ratio = contrast(theme[token], theme[surface]);
        assert.ok(ratio >= 4.5, `${name} --${token} ${theme[token]} on --${surface} ${theme[surface]} is only ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("repeated Copy URL clicks restart the feedback reset timer", async () => {
  let nextTimerId = 0;
  const timers = new Map();
  const page = loadPage(router(), {
    timerSet: (callback) => {
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    timerClear: (id) => timers.delete(id),
  });

  await page.copy();
  assert.equal(page.copyLabel(), "Copied ✓");
  assert.equal(timers.size, 1);
  const firstTimerId = timers.keys().next().value;

  await page.copy();
  assert.equal(page.copyLabel(), "Copied ✓");
  assert.equal(timers.size, 1, "the older reset timer must be cancelled");
  assert.notEqual(timers.keys().next().value, firstTimerId);

  timers.values().next().value();
  assert.equal(page.copyLabel(), "Copy URL");
});

test("an older clipboard write cannot overwrite feedback from the latest click", async () => {
  const writes = [];
  let nextTimerId = 0;
  const timers = new Map();
  const page = loadPage(router(), {
    writeClipboard: () => new Promise((resolve, reject) => writes.push({ resolve, reject })),
    timerSet: (callback) => {
      const id = ++nextTimerId;
      timers.set(id, callback);
      return id;
    },
    timerClear: (id) => timers.delete(id),
  });

  const first = page.copy();
  const second = page.copy();
  assert.equal(writes.length, 2);

  writes[1].resolve();
  await second;
  assert.equal(page.copyLabel(), "Copied ✓");

  writes[0].reject(new Error("stale clipboard failure"));
  await first;
  assert.equal(page.copyLabel(), "Copied ✓", "stale completion must not replace the latest result");
  assert.equal(timers.size, 1);

  const third = page.copy();
  assert.equal(page.copyLabel(), "Copying…");
  assert.equal(timers.size, 0, "a new pending click must cancel the previous feedback timer");
  writes[2].resolve();
  await third;
  assert.equal(page.copyLabel(), "Copied ✓");
  assert.equal(timers.size, 1);
});
