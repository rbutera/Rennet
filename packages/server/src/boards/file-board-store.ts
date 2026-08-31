import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event, WireSchema } from "@wboard/core";
import type { AppendEntry, BoardStore } from "@wboard/server";

/**
 * Durable {@link BoardStore} over a directory: per board, `schema.json`
 * (written once by {@link createBoard}) and `log.jsonl` (one line per event,
 * contiguous seqs from 1). The runtime roots it at `.rennet/boards/` under the
 * project — local, never staged. Restart = replay: a fresh instance over the
 * same directory serves the identical log.
 *
 * Matches the reference `InMemoryBoardStore` semantics: duplicate
 * `createBoard` and unknown-board `append` reject; unknown-board reads yield
 * empty/undefined — and ONLY unknown boards do: any other I/O failure or
 * corruption propagates rather than masquerading as absent data. The
 * ownership rule is honoured by construction — every event crosses a JSON
 * serialization boundary on write and read, so nothing the caller holds
 * aliases stored state.
 *
 * Batch atomicity is a recovery property, not a filesystem one: each line is
 * `{"end": <terminal seq of its batch>, "event": {...}}` and a whole batch
 * goes down in one `appendFile` call. A crash can still tear the tail of the
 * file, so readers drop (a) an unparseable final line and (b) a trailing
 * batch whose terminal seq never landed — the observable log is always
 * whole batches. Torn-tail recovery applies to the FINAL line only;
 * corruption anywhere else in the file throws.
 *
 * IN-MEMORY LOG (perf audit §3 H1 / §4 H4). The committed events and the board's
 * schema text are held in memory after the first read, so `getEvents(afterSeq)`
 * costs only the slice it returns rather than a full re-read and re-parse of the
 * whole log, and `append` stops re-reading `schema.json` per batch. This is the
 * same single-writer assumption the seq tail already ran on, now covering the
 * whole log: one runtime per project root owns the directory for the process's
 * life (`create-server` memoizes it), and a FRESH store re-reads from disk, which
 * is what restart recovery uses.
 * ponytail: single-writer O_APPEND assumed (the embedded BoardService is the
 * only writer); move to a lockfile if a second writing process ever appears —
 * the in-memory log would need invalidating too.
 */
export class FileBoardStore implements BoardStore {
  readonly #root: string;
  /**
   * Per-board committed log, loaded lazily and then extended in place by `append`.
   * `recovered` stays true until a write path heals the file — a read must never
   * heal, so the flag rides the cache instead of being lost by the first reader.
   */
  readonly #log = new Map<string, { events: Event[]; recovered: boolean }>();
  /** Per-board `schema.json` TEXT, cached once written or first read. Kept as text so
   *  every `getSchema` still parses its own copy — nothing a caller holds aliases ours. */
  readonly #schema = new Map<string, string>();
  /** Per-board write serialization so async create/append never interleave. */
  readonly #chain = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.#root = root;
  }

  #dir(boardId: string): string {
    // Board ids are service-minted, but the id is a trust boundary for path
    // construction. base64url is segment-safe AND reversible: unlike
    // encodeURIComponent it cannot emit ".", "..", or any path separator, so
    // no id can name a directory outside the root.
    return join(this.#root, Buffer.from(boardId, "utf8").toString("base64url"));
  }

  #serialize<T>(boardId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.#chain.get(boardId) ?? Promise.resolve()).then(work, work);
    this.#chain.set(
      boardId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Committed events, with crash recovery: a torn final line and a trailing
   * uncommitted batch are dropped (`recovered: true` tells the write path to
   * heal the file before appending). Mid-file corruption throws — that is
   * damage, not a crash tail. Only ENOENT reads as "no log yet".
   */
  async #readLog(boardId: string): Promise<{ events: Event[]; recovered: boolean }> {
    const path = join(this.#dir(boardId), "log.jsonl");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], recovered: false };
      }
      throw error;
    }
    const lines = raw.split("\n").filter((line) => line !== "");
    let recovered = false;
    const parsed: { end: number; event: Event }[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      try {
        parsed.push(JSON.parse(lines[i] as string) as { end: number; event: Event });
      } catch (error) {
        if (i === lines.length - 1) {
          recovered = true; // torn tail: the crash interrupted the final write
          break;
        }
        throw new Error(`corrupted board log: ${path} line ${i + 1}`, { cause: error });
      }
    }
    const last = parsed.at(-1);
    if (last !== undefined && last.event.seq !== last.end) {
      // The final batch never landed its terminal event: drop the whole batch.
      recovered = true;
      while (parsed.at(-1)?.end === last.end) parsed.pop();
    }
    return { events: parsed.map((line) => line.event), recovered };
  }

  /** The board's committed events, read from disk at most once per store instance.
   *  Reads NEVER heal — see {@link #healed}. */
  async #load(boardId: string): Promise<{ events: Event[]; recovered: boolean }> {
    let entry = this.#log.get(boardId);
    if (entry === undefined) {
      // A throw (mid-file corruption) is not cached: the next call re-reads and
      // throws again, rather than a fault being remembered as a value.
      entry = await this.#readLog(boardId);
      this.#log.set(boardId, entry);
    }
    return entry;
  }

  /** The board's committed events with the file healed if a crash left a garbage tail.
   *  Serialized-write context ONLY (append) — reads never rewrite. */
  async #healed(boardId: string): Promise<{ events: Event[]; recovered: boolean }> {
    const entry = await this.#load(boardId);
    if (entry.recovered) {
      // Heal before anything appends after the garbage tail. Temp-then-rename so the
      // heal itself is crash-safe: an in-place writeFile truncates first, and
      // a crash in that window would lose the whole log. A crash before the
      // rename leaves log.jsonl untouched (recovery just re-runs); rename is
      // atomic on the same filesystem.
      const dir = this.#dir(boardId);
      await writeFile(join(dir, "log.jsonl.heal"), logLines(entry.events));
      await rename(join(dir, "log.jsonl.heal"), join(dir, "log.jsonl"));
      entry.recovered = false;
    }
    return entry;
  }

  createBoard(boardId: string, schema: WireSchema): Promise<void> {
    // Serialized per board; "wx" makes schema.json write-once, which is also
    // the duplicate-board rejection the reference store specifies.
    const copy = JSON.stringify(schema);
    return this.#serialize(boardId, async () => {
      const dir = this.#dir(boardId);
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(join(dir, "schema.json"), copy, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`board already exists: ${boardId}`, { cause: error });
        }
        throw error;
      }
      this.#schema.set(boardId, copy);
      this.#log.set(boardId, { events: [], recovered: false });
    });
  }

  async getSchema(boardId: string): Promise<WireSchema | undefined> {
    // schema.json is write-once ("wx"), so its TEXT can be held for the store's life.
    // Only a successful read is cached: "unknown board" must stay re-checkable, since a
    // board can be created after someone asked for it.
    let raw = this.#schema.get(boardId);
    if (raw === undefined) {
      try {
        raw = await readFile(join(this.#dir(boardId), "schema.json"), "utf8");
      } catch (error) {
        // undefined is the contract's "unknown board" — nothing else may hide in it.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      this.#schema.set(boardId, raw);
    }
    return JSON.parse(raw) as WireSchema;
  }

  append(boardId: string, entries: readonly AppendEntry[]): Promise<Event[]> {
    // Copy at call time so caller mutations after the call cannot reach the log.
    const snapshot = entries.map((entry) => ({
      actor: entry.actor,
      op: structuredClone(entry.op),
    }));
    return this.#serialize(boardId, async () => {
      if ((await this.getSchema(boardId)) === undefined) {
        throw new Error(`unknown board: ${boardId}`);
      }
      const log = await this.#healed(boardId);
      const base = log.events.at(-1)?.seq ?? 0;
      const appended: Event[] = snapshot.map((entry, i) => ({
        seq: base + i + 1,
        actor: entry.actor,
        op: entry.op,
      }));
      if (appended.length > 0) {
        try {
          await appendFile(join(this.#dir(boardId), "log.jsonl"), logLines(appended));
        } catch (error) {
          // The file may now hold a partial batch: forget the log so the next
          // append re-reads and heals before writing anything after it.
          this.#log.delete(boardId);
          throw error;
        }
        log.events.push(...appended);
      }
      return structuredClone(appended);
    });
  }

  async getEvents(boardId: string, afterSeq: number): Promise<Event[]> {
    const { events } = await this.#load(boardId);
    // Clone the SLICE, not the log: the caller owns what it gets back (nothing it
    // mutates may reach stored state), and after the first read that cost is the new
    // events only — which is what `afterSeq` was always meant to buy.
    return structuredClone(events.filter((event) => event.seq > afterSeq));
  }
}

/** Serialize whole batches: every line carries its batch's terminal seq. */
function logLines(events: readonly Event[]): string {
  if (events.length === 0) return "";
  const end = events.at(-1)?.seq;
  return `${events.map((event) => JSON.stringify({ end, event })).join("\n")}\n`;
}
