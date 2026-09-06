import { isPrivateHost, validateRemoteUrl } from "./validate.js";

export async function fetchWithRedirectCheck(url, options = {}, maxRedirects = 5) {
  const timeoutMs = Number.isFinite(options.timeout) ? options.timeout : 8000;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 15 * 1024 * 1024;
  const { timeout: _timeout, maxBytes: _maxBytes, ...fetchOptions } = options;
  let currentUrl = url;

  for (let redirects = 0; ; redirects += 1) {
    const validation = await validateResolved(currentUrl);
    if (!validation.valid) throw new Error(validation.error);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(validation.url, {
        ...fetchOptions,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("FETCH_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      if (redirects >= maxRedirects) throw new Error("MAX_REDIRECTS_EXCEEDED");
      const location = response.headers.get("location");
      if (!location) throw new Error("REDIRECT_MISSING_LOCATION");
      const nextUrl = new URL(location, validation.url).toString();
      if (isPrivateHost(new URL(nextUrl).hostname)) throw new Error("FORBIDDEN_PRIVATE_REDIRECT");
      currentUrl = nextUrl;
      continue;
    }

    const length = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(length) && length > maxBytes) throw new Error("MAX_RESPONSE_SIZE_EXCEEDED");
    return response;
  }
}

async function validateResolved(url) {
  return validateRemoteUrl(url);
}
