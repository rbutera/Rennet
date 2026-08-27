import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event, WireSchema } from "@wboard/core";
import type { AppendEntry, BoardStore } from "@wboard/server";

/**
 * Durable {@link BoardStore} over a directory: per board, `schema.json`
 * (written once by {@link createBoard}) and `log.jsonl` (one event per line,
 * contiguous seqs from 1). The runtime roots it at `.rennet/boards/` under the
 * project — local, never staged. Restart = replay: a fresh instance over the
 * same directory serves the identical log.
 *
 * Matches the reference `InMemoryBoardStore` semantics: duplicate
 * `createBoard` and unknown-board `append` reject; unknown-board reads yield
 * empty/undefined. The ownership rule is honoured by construction — every
 * event crosses a JSON serialization boundary on write and read, so nothing
 * the caller holds aliases stored state.
 *
 * A batch is appended as one `appendFile` call so it lands contiguously or
 * not at all.
 * ponytail: single-write O_APPEND atomicity assumes one process owns the log
 * (true — the embedded BoardService is the single writer); move to a lockfile
 * if a second writing process ever appears.
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
    // construction — encode so no id can escape the root.
    return join(this.#root, encodeURIComponent(boardId));
  }

  #serialize<T>(boardId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.#chain.get(boardId) ?? Promise.resolve()).then(work, work);
    this.#chain.set(
      boardId,
      next.catch(() => undefined),
    );
    return next;
  }

  async #readLog(boardId: string): Promise<Event[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.#dir(boardId), "log.jsonl"), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Event);
  }

  async #lastSeq(boardId: string): Promise<number> {
    const known = this.#tail.get(boardId);
    if (known !== undefined) return known;
    const events = await this.#readLog(boardId);
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
    try {
      const raw = await readFile(join(this.#dir(boardId), "schema.json"), "utf8");
      return JSON.parse(raw) as WireSchema;
    } catch {
      return undefined;
    }
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
        const lines = `${appended.map((event) => JSON.stringify(event)).join("\n")}\n`;
        await appendFile(join(this.#dir(boardId), "log.jsonl"), lines);
        this.#tail.set(boardId, base + appended.length);
      }
      return structuredClone(appended);
    });
  }

  async getEvents(boardId: string, afterSeq: number): Promise<Event[]> {
    const events = await this.#readLog(boardId);
    return events.filter((event) => event.seq > afterSeq);
  }
}
