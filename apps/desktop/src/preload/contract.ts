/**
 * The preload bridge's key contract, as data (#386).
 *
 * The hardened-renderer e2e asserts `window.rennet` exposes EXACTLY this set —
 * catching accidental exposure — and imports the list from here instead of
 * hand-copying it, so adding a preload capability updates ONE place and the
 * e2e follows. A unit test in `index.test.ts` pins the real exposed object to
 * this list, closing the loop (the constant cannot drift from the code either).
 *
 * This module is import-safe outside Electron: no side effects, no electron
 * imports — that is the point (the Playwright spec runs in plain Node).
 */
export const RENNET_PRELOAD_KEYS = [
  "applyUpdate",
  "listWslDistros",
  "logWslConnect",
  "onUpdateReady",
  "platform",
  "resolveDaemonForPath",
  "version",
  "wsPort",
] as const;
