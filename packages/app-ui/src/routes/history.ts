import { useSyncExternalStore } from "react";
import type { BaseLocationHook, BaseSearchHook } from "wouter";
import { memoryLocation } from "wouter/memory-location";

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

// ── Hash history (Electron file:// origin) ───────────────────────────────────
// A file:// origin has no server routes AND no meaningful `location.search`, so BOTH
// the path and the query live inside the fragment: `#/s/review-1?view=map`. wouter's
// bundled `useHashLocation` returns the whole fragment un-split (so `:slug` captures
// `review-1?view=map`) and its search hook reads the empty real `location.search`.
// These PAIRED hooks split the fragment on `?` — the location hook yields the path, the
// search hook the query — so a hash deep link resolves both correctly.

const hashSubscribers = new Set<() => void>();
function fireHashChange(): void {
  for (const cb of [...hashSubscribers]) cb();
}
function subscribeHash(cb: () => void): () => void {
  if (hashSubscribers.size === 0) addEventListener("hashchange", fireHashChange);
  hashSubscribers.add(cb);
  return () => {
    hashSubscribers.delete(cb);
    if (hashSubscribers.size === 0) removeEventListener("hashchange", fireHashChange);
  };
}

/** Split `location.hash` (minus its leading '#') into a normalized path + raw query. */
function splitHash(): readonly [path: string, search: string] {
  const raw = location.hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const rawPath = q === -1 ? raw : raw.slice(0, q);
  const search = q === -1 ? "" : raw.slice(q + 1);
  return [`/${rawPath.replace(/^\/+/, "")}`, search];
}

/** Navigate by writing the whole `path?query` back into the fragment (never the real
 *  search — a file:// URL keeps everything in the hash). */
function hashNavigate(to: string, options: { replace?: boolean; state?: unknown } = {}): void {
  const url = new URL(location.href);
  url.hash = `#${to.startsWith("/") ? to : `/${to}`}`;
  history[options.replace ? "replaceState" : "pushState"](options.state ?? null, "", url.href);
  // pushState/replaceState never fire hashchange, so notify subscribers explicitly.
  dispatchEvent(
    typeof HashChangeEvent !== "undefined"
      ? new HashChangeEvent("hashchange")
      : new Event("hashchange"),
  );
}

const hashLocationHook: BaseLocationHook = () => [
  useSyncExternalStore(
    subscribeHash,
    () => splitHash()[0],
    () => "/",
  ),
  hashNavigate,
];
hashLocationHook.hrefs = (href: string) => `#${href}`;

const hashSearchHook: BaseSearchHook = () =>
  useSyncExternalStore(
    subscribeHash,
    () => splitHash()[1],
    () => "",
  );

/** Hash history for the Electron renderer (a `file://` origin has no server routes). */
export const hashHistory: RennetHistory = { hook: hashLocationHook, searchHook: hashSearchHook };

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
