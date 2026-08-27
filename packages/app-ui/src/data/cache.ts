import type { CommandInput, CommandName } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The command cache (C01 §2). react-query was evaluated against the dependency
// standard and REJECTED: the need is three hooks over a keyed store (dedupe an
// in-flight fetch, a stale flag on invalidate, per-key subscribers), and
// react-query's surface (refetch-on-focus, garbage collection, retries, devtools,
// infinite queries) far exceeds that and would need configuring-off. The owned
// engine below is ~120 lines, browser-safe, fully under our control, and — crucially
// — invisible outside `src/data/`: `useCommand`/`useCommandStream`/`useMutation` are
// the whole contract, so swapping in react-query later stays internal.
//
// The cache is an INSTANCE created per `BridgeProvider` (not a module global), so a
// test — or a second app mount — never inherits another's entries.
// ─────────────────────────────────────────────────────────────────────────────

/** The key separator. A command name is dotted and canonical JSON is space-free, so a
 *  bare name is an unambiguous key prefix that `invalidate` matches on. */
const SEP = "\u0000";

/** Canonical JSON with recursively sorted object keys, so `{a,b}` and `{b,a}` share a key. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** The cache key for a command read: the command name, then its canonically serialized input. */
export function commandKey<K extends CommandName>(name: K, input: CommandInput<K>): string {
  return `${name}${SEP}${stableStringify(input)}`;
}

/** The immutable snapshot a reader sees for one key. `fetching` is the in-flight flag; a
 *  hook derives `pending` (no data or error yet) from `data`/`error`. */
export interface QueryState<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly fetching: boolean;
  readonly stale: boolean;
}

const IDLE: QueryState<unknown> = {
  data: undefined,
  error: undefined,
  fetching: false,
  stale: false,
};

interface Entry {
  snapshot: QueryState<unknown>;
  promise?: Promise<unknown>;
  readonly listeners: Set<() => void>;
}

export class CommandCache {
  readonly #entries = new Map<string, Entry>();

  #entry(key: string): Entry {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { snapshot: IDLE, listeners: new Set() };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #set(key: string, next: QueryState<unknown>): void {
    const entry = this.#entry(key);
    entry.snapshot = next;
    for (const listener of [...entry.listeners]) listener();
  }

  /** Stable per-key snapshot for `useSyncExternalStore`'s `getSnapshot`. */
  getSnapshot(key: string): QueryState<unknown> {
    return this.#entry(key).snapshot;
  }

  subscribe(key: string, listener: () => void): () => void {
    const entry = this.#entry(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  /**
   * Run `fetcher` for `key` unless a fetch is already in flight (dedupe) or a fresh
   * value is already cached. A stale, errored, or never-fetched entry (re)fetches.
   */
  ensure(key: string, fetcher: () => Promise<unknown>): void {
    const entry = this.#entry(key);
    if (entry.promise) return; // in-flight: dedupe
    const snap = entry.snapshot;
    if (snap.data !== undefined && !snap.stale && snap.error === undefined) return; // fresh
    this.#set(key, { data: snap.data, error: snap.error, fetching: true, stale: false });
    const promise = fetcher();
    entry.promise = promise;
    void promise.then(
      (data) => {
        if (entry.promise !== promise) return; // superseded
        entry.promise = undefined;
        this.#set(key, { data, error: undefined, fetching: false, stale: false });
      },
      (error: unknown) => {
        if (entry.promise !== promise) return;
        entry.promise = undefined;
        this.#set(key, { data: snap.data, error, fetching: false, stale: false });
      },
    );
  }

  /** Fold a value into a key (a stream writes its events in here — the read sees ONE entry). */
  setData(key: string, update: (prev: unknown) => unknown): void {
    const snap = this.#entry(key).snapshot;
    this.#set(key, {
      data: update(snap.data),
      error: undefined,
      fetching: snap.fetching,
      stale: false,
    });
  }

  /** Mark every key whose command name matches `prefix` stale — a mounted reader refetches. */
  invalidate(prefix: string): void {
    for (const [key, entry] of this.#entries) {
      if (key === prefix || key.startsWith(`${prefix}${SEP}`)) {
        this.#set(key, { ...entry.snapshot, stale: true });
      }
    }
  }
}
