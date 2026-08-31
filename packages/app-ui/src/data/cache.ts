import type { CommandInput, CommandName } from "@rennet/protocol";
import { commandIdFor } from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// The command cache (C01 §2). react-query was evaluated against the dependency
// standard and REJECTED: the need is three hooks over a keyed store (dedupe an
// in-flight fetch, a stale flag on invalidate, a stale flag when the last reader
// leaves so a reopened surface re-reads, per-key subscribers), and
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
 * One stable, protocol-valid `commandId` per read key — see `commandIdFor` in protocol,
 * which owns the derivation next to the `z.uuid()` schema that judges it.
 *
 * Two constraints meet here and a hand-written id satisfies neither. The wire REJECTS a
 * readable id like `load-${slug}` — that is exactly how every `/s/:slug` rendered
 * "Couldn't open this review" and the chat dock read an empty transcript on the real app
 * (found driving it, F1 6.2). And a read's cache key includes its whole input, so the id
 * must be STABLE per key or a re-render remints the entry and two readers of one thing
 * fetch twice.
 *
 * Derived, not allocated: the session route screen and the chat dock get the SAME id for
 * the same review because they hash the same key — the property `slug.ts` and
 * `chat-data.ts` both document. It replaces a module-level Map that was mutated during
 * render and grew without bound; a pure function has neither problem.
 */
export function readCommandId(key: string): string {
  return commandIdFor(key);
}

/**
 * Commands whose answer CANNOT change for a given input, so a cached entry stays good
 * forever and a reader who leaves and comes back may be served it without a re-read.
 *
 * This is the one exception to "an unwatched entry has gone stale" below, and it is not a
 * performance preference — it is the immutable-patchset contract stated in code. A patchset
 * is fixed at capture; a span of one reads the same bytes today and next week, so refetching
 * it on every re-open of an evidence card spends a round trip to be told the same thing.
 * Everything NOT listed here is assumed to move while the surface is closed, because the
 * cost of being wrong that way is a surface quietly showing a past that reads as the present.
 */
const IMMUTABLE_READS: ReadonlySet<string> = new Set(["patchset.readSpan"]);

function isImmutableRead(key: string): boolean {
  return IMMUTABLE_READS.has(key.slice(0, key.indexOf(SEP)));
}

/**
 * RETENTION BOUNDS (perf audit §5 M — "CommandCache never evicts"). Entries only ever
 * accumulated, and an entry holds whatever the daemon answered with: `review.load` ships
 * every patchset ever captured WITH its full diff text, and a reattach carries a whole
 * session transcript. A day of opening reviews pinned every diff and every transcript for
 * the bridge's lifetime.
 *
 * What is released is the PAYLOAD, not the entry. The entry is a key, four numbers and an
 * empty listener set; the megabytes are in `snapshot.data`, which is the only thing the
 * audit measured. Deleting entries was tried and is WRONG: it resets `generation`, so an
 * entry re-created under a live reader loses the supersede bookkeeping and reads a second
 * time — `routes/app.dom.test.tsx` caught exactly that on an A → B → A navigation. The
 * accepted ceiling is therefore a map of empty entries that grows with the number of
 * distinct keys a session touches.
 *
 * The mutable window has to be GENEROUS, and that is a measurement, not a preference. An
 * unobserved entry is already stale (see `subscribe`), so its reopen refetches whether or
 * not the old data was still there — releasing costs no round trip on its own. What the
 * retained data buys is that the reopen renders the previous rows behind that refetch
 * instead of flashing empty, and the flash is not cosmetic: a surface that comes back
 * `pending` mounts a different tree, which churns subscriptions, which abandons more keys.
 * A window of 16 released `review.reattach` for the review the router was on its way back
 * to and cost a second read of it (caught by `routes/app.dom.test.tsx`'s A → B → A). Since
 * the sibling change making `Collapse` unmount its children, unsubscribe traffic is higher
 * again — every fold and every route switch frees subscribers.
 *
 * So the window is sized off the measured peak: the whole app-ui suite, driven end to end,
 * peaks at 37 simultaneously-abandoned keys. 256 is ~7× that — deep enough that no
 * navigation inside a session releases anything it is about to want, while a long day of
 * opening reviews still releases the diffs and transcripts behind it. The bound exists to
 * stop unbounded growth, not to evict aggressively.
 *
 * Immutable spans are the other class: `patchset.readSpan` is exempt from staleness by the
 * immutable-patchset contract, so nothing ever released it. Its window is generous, because
 * the point of keeping a span is that reopening an evidence card costs nothing: content-
 * addressed spans run a few hundred bytes to a few KB, and 1024 is more than a whole
 * 700-claim board's evidence cites while capping the class at single-digit MB. A span
 * pushed out is released AND marked stale — released means it must be re-read, and an
 * immutable read that came back is fresh again forever.
 *
 * Neither window ever touches an OBSERVED entry: a mounted reader cannot have its data
 * pulled out from under it.
 */
const ABANDONED_CAP = 256;
const IMMUTABLE_CAP = 1024;

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
  /** Bumped by a full-state write so an older read cannot overwrite authoritative state. */
  authoritativeGeneration: number;
  readonly listeners: Set<() => void>;
}

export class CommandCache {
  readonly #entries = new Map<string, Entry>();

  /** Keys with no reader left, least-recently-abandoned first (`Set` keeps insertion order,
   *  and every push re-inserts). Bounded by `ABANDONED_CAP`. */
  readonly #abandoned = new Set<string>();

  /** Immutable-read keys, least-recently-used first. Bounded by `IMMUTABLE_CAP`. */
  readonly #immutable = new Set<string>();

  #entry(key: string): Entry {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { snapshot: IDLE, generation: 0, authoritativeGeneration: 0, listeners: new Set() };
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

  /** Move `key` to the most-recently-used end of `order`, then RELEASE the payload of the
   *  oldest entries until the class is back inside `cap`. An observed entry is skipped and
   *  keeps both its place and its data. */
  #touch(order: Set<string>, key: string, cap: number): void {
    order.delete(key);
    order.add(key);
    if (order.size <= cap) return;
    for (const oldest of order) {
      if (order.size <= cap) break;
      const entry = this.#entries.get(oldest);
      if (entry && entry.listeners.size > 0) continue; // observed — not ours to release
      order.delete(oldest);
      // The entry survives (its generation is what keeps a later read honest); what it HOLDS
      // does not. `stale` is what makes the next reader re-read for it.
      if (entry) {
        entry.snapshot = {
          data: undefined,
          error: undefined,
          fetching: entry.snapshot.fetching,
          stale: true,
        };
      }
    }
  }

  subscribe(key: string, listener: () => void): () => void {
    const entry = this.#entry(key);
    entry.listeners.add(listener);
    // Observed again: out of the abandoned window, and an immutable read counts as used.
    if (isImmutableRead(key)) this.#touch(this.#immutable, key, IMMUTABLE_CAP);
    else this.#abandoned.delete(key);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0 || isImmutableRead(key)) return;
      // NOBODY IS WATCHING THIS KEY ANY MORE, and the server keeps moving without us. A
      // reader that comes back — a reviewer who leaves `/s/:slug` and returns — must be
      // shown what the daemon holds NOW, not the snapshot from when they left. Without
      // this the reattach entry survives with the same stable key, `ensure` sees fresh
      // data and skips the read entirely, and the transcript silently omits every message
      // that arrived while the route was closed. Only a full reload recovered it.
      //
      // Stale rather than dropped, so the reopen shows the old rows through the refetch
      // instead of flashing empty. The generation bump carries the same verdict to a fetch
      // that is still in flight: its completion cannot clear a staleness it never saw.
      entry.generation += 1;
      entry.snapshot = { ...entry.snapshot, stale: true };
      // …and the entry enters the bounded abandoned window, keeping its data only until
      // newer closings push it out.
      this.#touch(this.#abandoned, key, ABANDONED_CAP);
    };
  }

  /**
   * Run `fetcher` for `key` unless a fetch is already in flight (dedupe) or a fresh
   * value is already cached. A stale, errored, or never-fetched entry (re)fetches.
   */
  ensure(key: string, fetcher: () => Promise<unknown>): void {
    const entry = this.#entry(key);
    entry.fetcher = fetcher; // retain the latest fetcher for a self-refetch
    if (isImmutableRead(key)) this.#touch(this.#immutable, key, IMMUTABLE_CAP);
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
    const authoritativeGeneration = entry.authoritativeGeneration;
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
        const supersededByAuthoritativeWrite =
          entry.authoritativeGeneration !== authoritativeGeneration;
        this.#set(key, {
          data: superseded || supersededByAuthoritativeWrite ? entry.snapshot.data : data,
          error: undefined,
          fetching: false,
          stale: superseded,
        });
        // Refetch for a READER. An abandoned entry was superseded by its own last
        // unsubscribe; refetching it would spend a round trip on nobody and clear the very
        // staleness that makes the next reopen honest.
        if (superseded && entry.listeners.size > 0) this.#fetch(key, entry);
      },
      (error: unknown) => {
        if (entry.promise !== promise) return;
        entry.promise = undefined;
        const superseded = entry.generation !== generation;
        this.#set(key, { data: entry.snapshot.data, error, fetching: false, stale: superseded });
        if (superseded && entry.listeners.size > 0) this.#fetch(key, entry);
      },
    );
  }

  /** Fold a value into a key (a stream writes its events in here — the read sees ONE entry).
   *  Full-state writes may supersede an older in-flight read. Delta writes deliberately do
   *  not: their consumer must merge the eventual catch-up snapshot with the streamed tail. */
  setData(
    key: string,
    update: (prev: unknown) => unknown,
    options: { readonly supersedeInFlight?: boolean } = {},
  ): void {
    const entry = this.#entry(key);
    const snap = entry.snapshot;
    const data = update(snap.data);
    if (options.supersedeInFlight) entry.authoritativeGeneration += 1;
    this.#set(key, {
      data,
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
