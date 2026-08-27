import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
 * ponytail: single-writer O_APPEND assumed (the embedded BoardService is the
 * only writer); move to a lockfile if a second writing process ever appears.
 */
export class FileBoardStore implements BoardStore {
  readonly #root: string;
  /** Per-board tail: last assigned seq, loaded lazily from the log. */
  readonly #tail = new Map<string, number>();
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

  async #lastSeq(boardId: string): Promise<number> {
    const known = this.#tail.get(boardId);
    if (known !== undefined) return known;
    const { events, recovered } = await this.#readLog(boardId);
    if (recovered) {
      // Heal before anything appends after the garbage tail. Serialized-write
      // context only (append); reads never rewrite.
      await writeFile(join(this.#dir(boardId), "log.jsonl"), logLines(events));
    }
    const last = events.at(-1)?.seq ?? 0;
    this.#tail.set(boardId, last);
    return last;
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
      this.#tail.set(boardId, 0);
    });
  }

  async getSchema(boardId: string): Promise<WireSchema | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(this.#dir(boardId), "schema.json"), "utf8");
    } catch (error) {
      // undefined is the contract's "unknown board" — nothing else may hide in it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
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
      const base = await this.#lastSeq(boardId);
      const appended: Event[] = snapshot.map((entry, i) => ({
        seq: base + i + 1,
        actor: entry.actor,
        op: entry.op,
      }));
      if (appended.length > 0) {
        try {
          await appendFile(join(this.#dir(boardId), "log.jsonl"), logLines(appended));
        } catch (error) {
          // The file may now hold a partial batch: forget the tail so the next
          // append re-reads and heals before writing anything after it.
          this.#tail.delete(boardId);
          throw error;
        }
        this.#tail.set(boardId, base + appended.length);
      }
      return structuredClone(appended);
    });
  }

  async getEvents(boardId: string, afterSeq: number): Promise<Event[]> {
    const { events } = await this.#readLog(boardId);
    return events.filter((event) => event.seq > afterSeq);
  }
}

/** Serialize whole batches: every line carries its batch's terminal seq. */
function logLines(events: readonly Event[]): string {
  if (events.length === 0) return "";
  const end = events.at(-1)?.seq;
  return `${events.map((event) => JSON.stringify({ end, event })).join("\n")}\n`;
}
