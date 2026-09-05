// The live element stream behind a drafting lens board (`lens-board-tools` D11, task 4.1).
//
// A board is written call by call now, so the reviewer can watch one fill in. This is the
// daemon half of that: every accepted write reaches here as a `BoardWrite`, is folded into
// the board this hub holds for that `(review, generation, lens)`, and goes out as ONE frame
// carrying what the call touched.
//
// ── Why this is not the round-progress log ───────────────────────────────────────
// `RoundProgressHub` is an append-only log capped at 200 events per review, and a joining
// client catches up by replaying it. A board's writes are of the same order as that cap on
// their own — the Noise board of a 95-file change places one member per uncited region —
// so putting them in that log would evict the round's `operation` and `report` events and
// break the run machine's fold. So the frames are LIVE-ONLY and the catch-up is a
// SNAPSHOT: `board.draft` answers with the board as it stands plus the revision it is
// current with, and folding resumes from exactly there.
//
// ── Why there is no throttle ─────────────────────────────────────────────────────
// The lane's live line is throttled to four publications a second because each one
// re-sends the whole lane list; five idle lanes once pushed five whole snapshots a second
// to change one digit. An element frame is not a snapshot — it carries one call's worth of
// elements and stands alone — and its rate is bounded by the seat's ACCEPTED writes, which
// are tens per board over a turn that runs for a minute. A refused call publishes nothing.
//
// ── The generation key ───────────────────────────────────────────────────────────
// Every frame is stamped with the generation it belongs to and a revision monotonic within
// `(generation, lens)`. A superseded drafting attempt owns a different generation, so a
// reader rendering the live one drops its frames rather than merging two attempts' boards
// — the defect the reveal path shipped once already, in a different surface.

import type { BoardWrite } from "@rennet/core";
import type { LensDraftEvent, LensDraftSnapshot, LensDraftState, LensKind } from "@rennet/protocol";

/** One board being written, as this hub holds it. */
interface DraftRecord {
  readonly generation: string;
  readonly lens: LensKind;
  revision: number;
  state: LensDraftState;
  closed: boolean;
  elements: { id: string; element: LensDraftSnapshot["elements"][number] }[];
  document?: LensDraftSnapshot["document"];
}

const key = (generation: string, lens: LensKind): string => `${generation} ${lens}`;

/**
 * The live element streams of one daemon, keyed by review.
 *
 * Holds at most one record per `(review, generation, lens)`: opening a lane drops every
 * record of that review belonging to an older generation, so a review costs at most its
 * five boards. Nothing purges a review that never drafts again — that is a bounded cost
 * per review over a daemon's life, named here rather than answered with a sweep method
 * no production path would call.
 */
export class LensDraftHub {
  readonly #boards = new Map<string, Map<string, DraftRecord>>();
  readonly #broadcast: ((reviewId: string, event: LensDraftEvent) => void) | undefined;

  /** @param broadcast the live push sink (the WS listener's fan-out). Absent ⇒ the hub
   *  still folds, so the `board.draft` read is answerable with no live socket. */
  constructor(broadcast?: (reviewId: string, event: LensDraftEvent) => void) {
    this.#broadcast = broadcast;
  }

  /**
   * The lane opened its empty board. Also the RESET: a re-drafting attempt over the same
   * `(generation, lens)` clears what the last one wrote rather than appending to it, and
   * the revision keeps climbing so a reader can tell the reset from a replay.
   */
  opened(reviewId: string, generation: string, lens: LensKind): void {
    const records = this.#recordsFor(reviewId);
    // A review keeps at most ONE generation's boards here. The older ones are the
    // superseded attempt's, which no reader may render anyway (that is what the generation
    // key is for), so holding them is memory spent on frames that are already dropped.
    for (const [held, record] of [...records]) {
      if (record.generation !== generation) records.delete(held);
    }
    const held = records.get(key(generation, lens));
    const revision = held === undefined ? 0 : held.revision + 1;
    records.set(key(generation, lens), {
      generation,
      lens,
      revision,
      state: "drafting",
      closed: false,
      elements: [],
    });
    this.#push(reviewId, { generation, lens, revision, update: { kind: "opened" } });
  }

  /**
   * One accepted write. Emits at most two frames — the elements the call touched, then the
   * board's own state when the call moved it — and nothing at all when it moved neither,
   * which is what a `finish` that came back with pointers is.
   */
  wrote(reviewId: string, generation: string, lens: LensKind, write: BoardWrite): void {
    const record = this.#boards.get(reviewId)?.get(key(generation, lens));
    // No record means no lane opened this board here: a write with nowhere to be folded is
    // dropped rather than starting a stream whose beginning the reader never saw.
    if (record === undefined || record.closed) return;
    const removed = new Set(write.removed);
    if (removed.size > 0) {
      record.elements = record.elements.filter((entry) => !removed.has(entry.id));
    }
    for (const { index, element } of write.changed) {
      const at = record.elements.findIndex((entry) => entry.id === element.id);
      if (at === -1) record.elements.splice(index, 0, { id: element.id, element });
      else record.elements[at] = { id: element.id, element };
    }
    if (write.document !== undefined) record.document = write.document;
    const moved =
      write.changed.length > 0 || write.removed.length > 0 || write.document !== undefined;
    if (moved) {
      record.revision += 1;
      this.#push(reviewId, {
        generation,
        lens,
        revision: record.revision,
        update: {
          kind: "elements",
          changed: [...write.changed],
          removed: [...write.removed],
          ...(write.document === undefined ? {} : { document: write.document }),
        },
      });
    }
    if (write.state === record.state) return;
    record.state = write.state;
    record.revision += 1;
    this.#push(reviewId, {
      generation,
      lens,
      revision: record.revision,
      update: { kind: "state", state: write.state },
    });
  }

  /**
   * The lane settled: nothing more lands on this board. The closing frame carries how the
   * board finally STOOD, which on a failed lane is still `drafting` — the lane's own status
   * says whether the lane succeeded, and restating it here would be a second source for it.
   */
  closed(reviewId: string, generation: string, lens: LensKind): void {
    const record = this.#boards.get(reviewId)?.get(key(generation, lens));
    if (record === undefined || record.closed) return;
    record.closed = true;
    record.revision += 1;
    this.#push(reviewId, {
      generation,
      lens,
      revision: record.revision,
      update: { kind: "closed", state: record.state },
    });
    // KEPT, not dropped. A lane that FAILED persisted no board, so `board.read` has
    // nothing to serve and the elements the seat did write would otherwise be readable
    // only by a client that happened to be watching — the partial board task 3.3 says is
    // kept, kept for one reader and lost for the next. The record leaves when this
    // review's next generation opens a lane, which bounds this to five boards per review.
  }

  /** The board as it stands, for a reader that joined mid-draft. `undefined` when no lane
   *  of that generation ever opened this lens on this daemon. */
  read(reviewId: string, generation: string, lens: LensKind): LensDraftSnapshot | undefined {
    const record = this.#boards.get(reviewId)?.get(key(generation, lens));
    if (record === undefined) return undefined;
    return {
      generation: record.generation,
      lens: record.lens,
      revision: record.revision,
      state: record.state,
      closed: record.closed,
      elements: record.elements.map((entry) => entry.element),
      ...(record.document === undefined ? {} : { document: record.document }),
    };
  }

  #recordsFor(reviewId: string): Map<string, DraftRecord> {
    const held = this.#boards.get(reviewId);
    if (held !== undefined) return held;
    const fresh = new Map<string, DraftRecord>();
    this.#boards.set(reviewId, fresh);
    return fresh;
  }

  #push(reviewId: string, event: LensDraftEvent): void {
    this.#broadcast?.(reviewId, event);
  }
}
