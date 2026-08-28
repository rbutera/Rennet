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

/**
 * One stable, protocol-valid `commandId` per read key.
 *
 * Two constraints meet here and a hand-written id satisfies neither. The wire's
 * `commandIdSchema` is `z.uuid()`, so a readable id like `load-${slug}` is REJECTED by
 * the daemon — that is exactly how every `/s/:slug` rendered "Couldn't open this review"
 * and the chat dock read an empty transcript on the real app (found driving it, F1 6.2).
 * And a read's cache key includes its whole input, so the id must be STABLE per key or a
 * re-render remints the entry and two readers of one thing fetch twice.
 *
 * The map is module-level for that second reason: the session route screen and the chat
 * dock derive the SAME id for the same review, so they share one entry — the property
 * `slug.ts` and `chat-data.ts` both document. Same shape as the per-project run ids in
 * `indexing-view.tsx` / `project-processing.tsx`, which needed a stable valid id first.
 *
 * ponytail: unbounded map keyed by review/session id; bound it if a client ever holds
 * enough distinct reads for the retention to matter.
 */
const readCommandIds = new Map<string, string>();
export function readCommandId(key: string): string {
  const existing = readCommandIds.get(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  readCommandIds.set(key, created);
  return created;
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
  /** The latest fetcher for this key, retained so a mid-flight invalidation self-refetches. */
  fetcher?: () => Promise<unknown>;
  /** Bumped by `invalidate`; a fetch that completes at a stale generation refetches. */
  generation: number;
  readonly listeners: Set<() => void>;
}

export class CommandCache {
  readonly #entries = new Map<string, Entry>();

  #entry(key: string): Entry {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { snapshot: IDLE, generation: 0, listeners: new Set() };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #set(key: string, next: QueryState<unknown>): void {
    const entry = this.#entry(key);
    entry.snapshot = next;
    for (const listener of [...entry.listeners]) listener();
  }

  /** Stable per-key snapshot for `useSyncExternalStore`'s `getSnapshot`. Never creates an
   *  entry — a read must not mutate the store during render (an absent key is IDLE). */
  getSnapshot(key: string): QueryState<unknown> {
    return this.#entries.get(key)?.snapshot ?? IDLE;
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
    entry.fetcher = fetcher; // retain the latest fetcher for a self-refetch
    if (entry.promise) return; // in-flight: dedupe
    const snap = entry.snapshot;
    if (snap.data !== undefined && !snap.stale && snap.error === undefined) return; // fresh
    this.#fetch(key, entry);
  }

  /** Start a fetch, tagging it with the entry's current generation. A completion at a
   *  STALER generation (an `invalidate` landed mid-flight) cannot clear the stale flag —
   *  it installs its result then refetches, so a mutation's invalidation is never erased.
   *  Both settle paths preserve the entry's LIVE data (a stream may have folded newer
   *  state during the flight), never a snapshot captured before the fetch began. */
  #fetch(key: string, entry: Entry): void {
    const fetcher = entry.fetcher;
    if (!fetcher) return;
    const generation = entry.generation;
    this.#set(key, {
      data: entry.snapshot.data,
      error: entry.snapshot.error,
      fetching: true,
      stale: false,
    });
    const promise = fetcher();
    entry.promise = promise;
    void promise.then(
      (data) => {
        if (entry.promise !== promise) return; // a newer #fetch owns the entry
        entry.promise = undefined;
        const superseded = entry.generation !== generation;
        this.#set(key, { data, error: undefined, fetching: false, stale: superseded });
        if (superseded) this.#fetch(key, entry);
      },
      (error: unknown) => {
        if (entry.promise !== promise) return;
        entry.promise = undefined;
        const superseded = entry.generation !== generation;
        this.#set(key, { data: entry.snapshot.data, error, fetching: false, stale: superseded });
        if (superseded) this.#fetch(key, entry);
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
        entry.generation += 1; // supersede any in-flight fetch so its completion refetches
        this.#set(key, { ...entry.snapshot, stale: true });
      }
    }
  }
}
