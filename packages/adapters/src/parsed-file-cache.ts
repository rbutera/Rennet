import { statSync } from "node:fs";

/** How many files one cache keeps parsed. Entries are per-FILE parsed states — one ask log,
 *  one thread, one transcript, one session record each — so a working session has dozens
 *  live, not thousands; 256 keeps every one of them warm and bounds the pathological case
 *  (a `list()` walking a directory of hundreds of stale sessions). */
export const PARSED_FILE_CACHE_LIMIT = 256;

/**
 * A per-path memo of a JSON file's PARSED state, so a read-modify-write store stops
 * re-reading and re-validating its whole file on every call (perf audit §3 H1 / §4 H4–H5:
 * the ask log, thread, transcript and session stores each did one full read + one zod walk
 * per operation, which is O(n) per write and O(n²) per session).
 *
 * The daemon is the only WRITER of these files, but it is not the only READER: the E2E
 * suites open a second store instance over the same directory and poll it while the daemon
 * writes (`board-lenses.spec.ts` polls `AskLogStore.readProjection`, `publish-proof-fixture.ts`
 * polls `SessionStore.load`). So a blind memo would serve those readers a snapshot that never
 * changes. Instead every hit is validated by ONE `stat` — inode + size + nanosecond mtime —
 * which costs a single syscall and skips the read, the `JSON.parse` and the schema walk that
 * were the actual expense. A foreign write lands a new inode (every writer here is
 * temp-then-rename) and misses; the cache is a memo, never an authority.
 */
export class ParsedFileCache<T> {
  readonly #entries = new Map<string, { stamp: string; value: T }>();

  /** The memoized value for `path`, or `undefined` if absent or superseded on disk. */
  get(path: string): T | undefined {
    const entry = this.#entries.get(path);
    if (entry === undefined) return undefined;
    if (entry.stamp !== stampOf(path)) {
      this.#entries.delete(path);
      return undefined;
    }
    // delete-then-set: Map is insertion-ordered, so re-inserting makes this the newest use
    // and eviction in `set` takes the coldest.
    this.#entries.delete(path);
    this.#entries.set(path, entry);
    return entry.value;
  }

  /** Memoize `value` as the parse of the file at `path` AS IT IS NOW. A caller that just
   *  wrote the file passes what it wrote; the stamp is taken from the file it landed.
   *
   *  The stamp is read AFTER that write, so a foreign writer landing in between would have
   *  ITS file memoized under OUR value. Accepted, under the same single-writer assumption the
   *  rest of this cache runs on: the daemon is the only writer of these paths and the second
   *  instances only read. A known ceiling, named rather than guarded. */
  set(path: string, value: T): void {
    const stamp = stampOf(path);
    this.#entries.delete(path);
    if (stamp === undefined) return;
    this.#entries.set(path, { stamp, value });
    while (this.#entries.size > PARSED_FILE_CACHE_LIMIT) {
      const coldest = this.#entries.keys().next();
      if (coldest.done) break;
      this.#entries.delete(coldest.value);
    }
  }
}

/** The identity of a file's current contents: inode, size, and mtime to the nanosecond.
 *  `undefined` when the file is gone — which reads as "not what we memoized". */
function stampOf(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return undefined;
  }
}
