import { create } from "zustand";
import { MARKS, type MarkId } from "./marks";

// ─────────────────────────────────────────────────────────────────────────────
// The coach-mark store (C13 Cluster 1). Ported from the reviewed spike
// (`spikes/board-prototype/lib/tour.ts`) with two structural rewrites the autopsy
// (comment 5431046732) demands:
//
//   1. Persistence is INJECTED, not `localStorage` (§13: localStorage dies). The
//      provider (Cluster 3) reads the initial `{seen, skipAll}` from `settings.get`,
//      feeds it as `initial`, and supplies a `persist` that writes to
//      `client-settings.json` via `settings.setCoachmarks`. This store knows
//      nothing about the transport.
//   2. NO module-level mutable state (autopsy S8). The chain timer lives in the
//      factory closure — one per store instance — never at module scope, so two
//      stores never share a suppression window.
//
// Election is one-at-a-time: the first unseen registered mark in system order
// (`MARKS`) wins. Dismissing opens a short gap before the next mark on the same
// surface fires. `registered` is ephemeral (a surface is mounted); only
// `seen`/`skipAll` persist.
// ─────────────────────────────────────────────────────────────────────────────

/** The persisted slice — mirrored into `client-settings.json` by the provider. */
export interface CoachSnapshot {
  seen: MarkId[];
  skipAll: boolean;
}

type Flags = Partial<Record<MarkId, boolean>>;

/** Default gap between a dismissed mark and the next on the same surface. */
const DEFAULT_CHAIN_DELAY_MS = 600;

/** First unseen mark whose surface is registered, in system order. */
function elect(seen: Flags, registered: Flags, skipAll: boolean): MarkId | null {
  if (skipAll) return null;
  return MARKS.find((m) => registered[m.id] && !seen[m.id])?.id ?? null;
}

/** Flags → the persisted array, in system order. */
function seenList(seen: Flags): MarkId[] {
  return MARKS.map((m) => m.id).filter((id) => seen[id]);
}

export interface CoachState {
  seen: Flags;
  skipAll: boolean;
  /** Marks whose surface is currently mounted. */
  registered: Flags;
  active: MarkId | null;
  register: (id: MarkId) => void;
  unregister: (id: MarkId) => void;
  /** Retire a mark for good — dismissed by ✕, or learned by using the anchor. */
  dismiss: (id: MarkId) => void;
  skipEverything: () => void;
  replay: () => void;
}

export interface CoachStoreDeps {
  /** Initial persisted state, fed by the provider from `settings.get`. */
  initial: CoachSnapshot;
  /** Called on every `seen`/`skipAll` change; the provider persists it. */
  persist: (snapshot: CoachSnapshot) => void;
  /** Gap before the next mark on the same surface. Overridable in tests. */
  chainDelayMs?: number;
}

export type CoachStore = ReturnType<typeof createCoachStore>;

export function createCoachStore({
  initial,
  persist,
  chainDelayMs = DEFAULT_CHAIN_DELAY_MS,
}: CoachStoreDeps) {
  // Per store instance, NOT module scope (autopsy S8): each store owns its own
  // chain-gap timer, so nothing leaks between two stores or between test cases.
  let chainTimer: ReturnType<typeof setTimeout> | null = null;
  const clearChain = () => {
    if (chainTimer) {
      clearTimeout(chainTimer);
      chainTimer = null;
    }
  };

  return create<CoachState>()((set, get) => ({
    seen: Object.fromEntries(initial.seen.map((id) => [id, true])) as Flags,
    skipAll: initial.skipAll,
    registered: {},
    active: null,
    register: (id) => {
      if (get().registered[id]) return;
      const registered = { ...get().registered, [id]: true };
      // A surface mounting mid-gap must not jump the queue — hold election until
      // the gap closes.
      set({ registered, active: chainTimer ? null : elect(get().seen, registered, get().skipAll) });
    },
    unregister: (id) => {
      if (!get().registered[id]) return;
      const registered = { ...get().registered };
      delete registered[id];
      set({ registered, active: chainTimer ? null : elect(get().seen, registered, get().skipAll) });
    },
    dismiss: (id) => {
      if (get().seen[id]) return;
      const seen = { ...get().seen, [id]: true };
      set({ seen, active: null });
      persist({ seen: seenList(seen), skipAll: get().skipAll });
      clearChain();
      chainTimer = setTimeout(() => {
        chainTimer = null;
        const s = get();
        set({ active: elect(s.seen, s.registered, s.skipAll) });
      }, chainDelayMs);
    },
    skipEverything: () => {
      clearChain();
      set({ skipAll: true, active: null });
      persist({ seen: seenList(get().seen), skipAll: true });
    },
    replay: () => {
      clearChain();
      set({ seen: {}, skipAll: false, active: elect({}, get().registered, false) });
      persist({ seen: [], skipAll: false });
    },
  }));
}
