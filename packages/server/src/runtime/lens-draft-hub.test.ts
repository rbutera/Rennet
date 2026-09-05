import type { BoardWrite } from "@rennet/core";
import type { DraftBoard, DraftElement, LensDraftEvent } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { LensDraftHub } from "./lens-draft-hub";

/**
 * The live element stream's fold (`lens-board-tools` D11, task 4.1).
 *
 * Every assertion here reads the frames the hub PUBLISHED and the snapshot it would serve
 * to a late reader, never a reconstruction of either.
 */

const element = (id: string, markdown: string): DraftElement =>
  ({
    id,
    kind: "prose",
    data: { author: { kind: "lens-agent", id: "seat" }, markdown },
  }) as DraftElement;

/** The board an ordinary first open starts from. */
const EMPTY: DraftBoard = { elements: [] };

const write = (over: Partial<BoardWrite> = {}): BoardWrite => ({
  changed: [],
  removed: [],
  state: "drafting",
  ...over,
});

const collected = () => {
  const frames: { reviewId: string; event: LensDraftEvent }[] = [];
  const hub = new LensDraftHub((reviewId, event) => frames.push({ reviewId, event }));
  return { hub, frames };
};

describe("LensDraftHub", () => {
  it("opens an empty board and publishes the open, so a reader starts from nothing", () => {
    const { hub, frames } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      reviewId: "rev-1",
      event: {
        generation: "gen-1",
        lens: "sequence",
        revision: 0,
        update: { kind: "opened", elements: [] },
      },
    });
    expect(hub.read("rev-1", "gen-1", "sequence")).toEqual({
      generation: "gen-1",
      lens: "sequence",
      revision: 0,
      state: "drafting",
      closed: false,
      elements: [],
    });
  });

  it("folds each write into the board it serves, and the frame carries only that write", () => {
    const { hub, frames } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 1, element: element("e2", "two") }] }),
    );
    // One frame per write, each carrying ONE element — not the board so far.
    const elementFrames = frames.filter(({ event }) => event.update.kind === "elements");
    expect(elementFrames).toHaveLength(2);
    for (const { event } of elementFrames) {
      expect(event.update.kind === "elements" && event.update.changed).toHaveLength(1);
    }
    // …and the board the hub serves is the fold of them.
    expect(hub.read("rev-1", "gen-1", "sequence")?.elements.map(({ id }) => id)).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("replaces an element in place when a later call changes it", () => {
    const { hub } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "first draft") }] }),
    );
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "revised") }] }),
    );
    const elements = hub.read("rev-1", "gen-1", "sequence")?.elements ?? [];
    expect(elements).toHaveLength(1);
    expect((elements[0]?.data as { markdown?: string } | undefined)?.markdown).toBe("revised");
  });

  it("drops a removed element from the board it serves", () => {
    const { hub } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({
        changed: [
          { index: 0, element: element("e1", "one") },
          { index: 1, element: element("e2", "two") },
        ],
      }),
    );
    hub.wrote("rev-1", "gen-1", "sequence", write({ removed: ["e1"] }));
    expect(hub.read("rev-1", "gen-1", "sequence")?.elements.map(({ id }) => id)).toEqual(["e2"]);
  });

  it("publishes the board's state only when it MOVED", () => {
    const { hub, frames } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    expect(frames.filter(({ event }) => event.update.kind === "state")).toHaveLength(0);
    // `finish` that came back with pointers: nothing moved and nothing is published.
    hub.wrote("rev-1", "gen-1", "sequence", write({}));
    expect(frames.filter(({ event }) => event.update.kind === "state")).toHaveLength(0);
    hub.wrote("rev-1", "gen-1", "sequence", write({ state: "settled" }));
    const stateFrames = frames.filter(({ event }) => event.update.kind === "state");
    expect(stateFrames).toHaveLength(1);
    expect(stateFrames[0]?.event.update).toEqual({ kind: "state", state: "settled" });
  });

  it("gives every frame of a board a strictly increasing revision", () => {
    const { hub, frames } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }], state: "settled" }),
    );
    hub.closed("rev-1", "gen-1", "sequence");
    const revisions = frames.map(({ event }) => event.revision);
    // POSITION, not membership: a set of revisions is satisfied by frames published out of
    // order, which is exactly what a reader folding by revision would then mis-order.
    expect(revisions).toEqual([0, 1, 2, 3]);
    expect(frames.map(({ event }) => event.update.kind)).toEqual([
      "opened",
      "elements",
      "state",
      "closed",
    ]);
  });

  it("keeps two lenses of one generation apart", () => {
    const { hub } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.opened("rev-1", "gen-1", "flagged", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    expect(hub.read("rev-1", "gen-1", "sequence")?.elements).toHaveLength(1);
    expect(hub.read("rev-1", "gen-1", "flagged")?.elements).toHaveLength(0);
  });

  it("drops a superseded generation's board when the next one opens", () => {
    // The generation key is what stops one attempt painting over another. Holding the old
    // attempt's board would keep memory for frames no reader may render anyway.
    const { hub } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    hub.opened("rev-1", "gen-2", "sequence", EMPTY);
    expect(hub.read("rev-1", "gen-1", "sequence")).toBeUndefined();
    expect(hub.read("rev-1", "gen-2", "sequence")?.elements).toEqual([]);
  });

  it("re-opens from the board the lane HOLDS, not from nothing", () => {
    // The lane's writer survives a settle — nothing deletes a lane — so a re-opened lane
    // hands back a board that already holds elements. Seeding the reader from `[]` there
    // left every later `changed[].index`, which is computed against the BOARD's list,
    // pointing past the end of the reader's copy: the fold scrambled from the first write.
    //
    // CONTROL, run 2026-09-05: seed the record with `[]` instead of the board and this
    // reddens with `expected [] to deeply equal [ 'e1' ]`.
    const { hub, frames } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    const held: DraftBoard = { elements: [element("e1", "one")] };
    hub.opened("rev-1", "gen-1", "sequence", held);
    expect(hub.read("rev-1", "gen-1", "sequence")?.elements.map(({ id }) => id)).toEqual(["e1"]);
    expect(frames.at(-1)?.event.update).toEqual({ kind: "opened", elements: held.elements });
    // A revision that reset would read as a duplicate of the first frame, and a reader
    // folding by revision would drop the re-open and keep the stale board.
    expect(frames.at(-1)?.event.revision).toBe(2);

    // …and the NEXT write lands where the board says it does, which is the whole point.
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 1, element: element("e2", "two") }] }),
    );
    expect(hub.read("rev-1", "gen-1", "sequence")?.elements.map(({ id }) => id)).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("re-opens a DIFFERENT generation from nothing, whatever the last one held", () => {
    // The reset half of `opened` is still load-bearing: a new generation's board is its
    // own, and a reader must not append it onto the last one's.
    const { hub } = collected();
    hub.opened("rev-1", "gen-1", "sequence", { elements: [element("e1", "one")] });
    hub.opened("rev-1", "gen-2", "sequence", EMPTY);
    expect(hub.read("rev-1", "gen-2", "sequence")?.elements).toEqual([]);
  });

  it("drops a write for a board no lane opened here", () => {
    // A stream whose beginning the reader never saw is not a stream it can fold.
    const { hub, frames } = collected();
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    expect(frames).toEqual([]);
    expect(hub.read("rev-1", "gen-1", "sequence")).toBeUndefined();
  });

  it("closes with how the board finally STOOD, and takes nothing more", () => {
    const { hub, frames } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    hub.closed("rev-1", "gen-1", "sequence");
    // A lane that FAILED closes with its board still `drafting`: the lane's own status is
    // what says whether the lane succeeded, and restating it here would be a second source.
    expect(frames.at(-1)?.event.update).toEqual({ kind: "closed", state: "drafting" });
    const after = frames.length;
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 1, element: element("e2", "two") }] }),
    );
    hub.closed("rev-1", "gen-1", "sequence");
    expect(frames).toHaveLength(after);
  });

  it("still serves a failed lane's partial board after it closed", () => {
    // A failed lane persists no board, so `board.read` has nothing. The elements the seat
    // did write are kept here — the partial board 3.3 keeps, kept for the NEXT reader too
    // and not only for the one that happened to be watching.
    const { hub } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    hub.closed("rev-1", "gen-1", "sequence");
    const board = hub.read("rev-1", "gen-1", "sequence");
    expect(board?.closed).toBe(true);
    expect(board?.state).toBe("drafting");
    expect(board?.elements.map(({ id }) => id)).toEqual(["e1"]);
  });

  it("keeps two reviews apart", () => {
    const { hub } = collected();
    hub.opened("rev-1", "gen-1", "sequence", EMPTY);
    hub.opened("rev-2", "gen-1", "sequence", EMPTY);
    hub.wrote(
      "rev-1",
      "gen-1",
      "sequence",
      write({ changed: [{ index: 0, element: element("e1", "one") }] }),
    );
    expect(hub.read("rev-1", "gen-1", "sequence")?.elements).toHaveLength(1);
    expect(hub.read("rev-2", "gen-1", "sequence")?.elements).toHaveLength(0);
  });
});
