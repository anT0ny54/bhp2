// Single Sharp loader shared by functions/index.js and functions/health.js,
// so both report the same module and apply the same runtime configuration.
let sharpPromise;

export function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((module) => {
        const sharp = module.default || module;
        // Favor predictable memory use on small serverless instances. This limits
        // libvips threads per image; it does not limit concurrent invocations.
        sharp.concurrency(1);
        return sharp;
      })
      .catch((error) => {
        // A failed import is retried on the next request instead of being cached.
        sharpPromise = undefined;
        throw error;
      });
  }
  return sharpPromise;
}
