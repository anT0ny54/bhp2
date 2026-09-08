// Legacy import surface retained for clients that imported util/fetch directly.
export async function fetchWithRedirectCheck(url, options = {}, maxRedirects = 5) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 8000;
  const { timeout: _timeout, maxBytes: _maxBytes, ...fetchOptions } = options;
  const deadline = Date.now() + timeout;
  let current = url;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(current, { ...fetchOptions, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= maxRedirects) throw new Error("MAX_REDIRECTS_EXCEEDED");
      const location = response.headers.get("location");
      if (!location) throw new Error("REDIRECT_MISSING_LOCATION");
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error("MAX_REDIRECTS_EXCEEDED");
}
