import type { BaseLocationHook, BaseSearchHook } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useHashLocation } from "wouter/use-hash-location";

// ─────────────────────────────────────────────────────────────────────────────
// Injected history (C01 §4.1). The host supplies the history exactly as it supplies
// the bridge: `app-ui` never picks. `RennetRouterApp` takes a `RennetHistory` and
// hands its hooks to wouter's `<Router>`.
//   • Electron (file://)   → hash history      (`hashHistory`)
//   • served browser tab   → browser history   (the wouter default; `browserHistory`)
//   • tests                → memory history     (`memoryHistory`, records for assertions)
// This is the ONE place a router history is chosen, so the environments never drift.
// ─────────────────────────────────────────────────────────────────────────────

export interface RennetHistory {
  /** wouter location hook; omitted ⇒ the browser default (served-tab shell). */
  readonly hook?: BaseLocationHook;
  /** wouter search hook; omitted ⇒ the browser default. */
  readonly searchHook?: BaseSearchHook;
}

/** Hash history for the Electron renderer (a `file://` origin has no server routes). */
export const hashHistory: RennetHistory = { hook: useHashLocation };

/** Browser history for the daemon-served tab (the wouter default — no hooks needed). */
export const browserHistory: RennetHistory = {};

/** A recording memory history for tests: `history` is the visited-path log, `navigate` drives it. */
export function memoryHistory(initialPath = "/"): RennetHistory & {
  navigate: (to: string, options?: { replace?: boolean }) => void;
  history: string[];
} {
  const memory = memoryLocation({ path: initialPath, record: true });
  return {
    hook: memory.hook,
    searchHook: memory.searchHook,
    navigate: memory.navigate,
    history: memory.history,
  };
}
