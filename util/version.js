// Single source of truth for version/feature metadata.
//
// History note: this project has twice drifted into a state where
// functions/health.js reported an older PROXY_VERSION than the one actually
// running in functions/index.js (see CHANGELOG 2.2.4 and 2.2.6), because the
// version string was hand-copied into more than one file. Importing these
// constants everywhere they're needed removes the duplication that caused
// the drift, rather than just re-syncing the numbers one more time.
export const PROXY_VERSION = "2.2.7";
export const API_VERSION = "1";
export const FEATURES = Object.freeze(["webp", "grayscale", "maxwidth", "stats"]);
