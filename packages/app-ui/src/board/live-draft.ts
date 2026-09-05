import {
  type BoardDocument,
  type DraftElement,
  LENS_KINDS,
  type LensBoard,
  type LensDraftEvent,
  type LensDraftSnapshot,
  type LensDraftState,
  type LensKind,
  projectBoardSections,
  resolveBoardDocument,
} from "@rennet/protocol";
import { useCommand, useCommandStream } from "../data";

// ─────────────────────────────────────────────────────────────────────────────
// THE BOARD AS IT IS BEING WRITTEN (lens-board-tools 5.3, D11/D13) — the client end
// of the element stream.
//
// The daemon publishes one `lensDraft` frame per ACCEPTED board tool call, and
// `board.draft` serves the board as it stands plus the revision to fold from. This is
// the caller `onLensDraft` was left without.
//
// TWO SOURCES, AND WHICH ONE WINS. `board.read` serves the board the pipeline PERSISTED;
// this stream serves the one a seat is writing right now. While a lane is open the stream
// is the fresher of the two and is what the reviewer watches; the moment the lane closes
// the durable copy is authoritative, because that is the copy that carries the patchset
// stamps and the round-delta marks a drafting element has never had. `useLiveBoard` below
// is that switch, and it is the only place the two are compared.
//
// THE FOLD, and the three ways it can be wrong:
//
//   • A frame for ANOTHER GENERATION is dropped, never merged. A re-drafting attempt owns
//     a different generation id, and the reveal path has already shipped the bug where two
//     attempts painted over each other once.
//   • A frame at or below the revision already folded is a DUPLICATE and is dropped;
//     `revision` is monotonic per `(generation, lens)` and never resets.
//   • An `opened` frame is the RESET marker and carries the board it is starting from,
//     which is not always empty: nothing deletes a lane, a generation id is
//     content-addressed, and a lane re-opened for a retry (or opened by a second review of
//     identical content) hands back the board already there. Seeding from empty would leave
//     the reader's copy shorter than the board, and every later `index` is computed against
//     the board's own list — the fold would scramble from the first write.
//
// A GAP is not repaired here and is not silently absorbed: a frame whose revision skips
// past the folded one is applied, and the snapshot the read supplies is what closes a gap
// left by a socket that was down. Refusing the frame would freeze the board on a stale
// revision for the rest of the lane, which is worse than a board briefly missing one
// call's elements — the durable read is the backstop either way.
// ─────────────────────────────────────────────────────────────────────────────

/** A board being written, as this client currently holds it. */
export interface LiveDraft {
  readonly generation: string;
  readonly lens: LensKind;
  readonly revision: number;
  readonly state: LensDraftState;
  /** The lane settled: nothing more will land on this board. */
  readonly closed: boolean;
  readonly elements: readonly DraftElement[];
  readonly document?: BoardDocument;
}

/**
 * Fold one published write into the snapshot. PURE and exported, because this is the part
 * with the three ways to be wrong above and it is worth testing without a socket.
 *
 * `undefined` in means "no snapshot yet": only an `opened` frame can start one, because
 * every other kind places its elements by an index into a board this reader does not have.
 */
export function foldLensDraft(
  current: LensDraftSnapshot | undefined,
  event: LensDraftEvent,
  expected: { readonly generation: string; readonly lens: LensKind },
): LensDraftSnapshot | undefined {
  if (event.generation !== expected.generation || event.lens !== expected.lens) return current;
  if (current !== undefined && event.revision <= current.revision) return current;
  const update = event.update;
  if (update.kind === "opened") {
    return {
      generation: event.generation,
      lens: event.lens,
      revision: event.revision,
      state: "drafting",
      closed: false,
      elements: update.elements,
      ...(update.document === undefined ? {} : { document: update.document }),
    };
  }
  if (current === undefined) return current;
  const base = { ...current, revision: event.revision };
  switch (update.kind) {
    case "elements": {
      const removed = new Set(update.removed);
      const elements = current.elements.filter((element) => !removed.has(element.id));
      // `index` is the position in the BOARD's own list, so a changed element replaces the
      // one at that index and a new one extends the list. Applying in index order keeps a
      // single call's writes from re-ordering each other.
      const next = [...elements];
      for (const { index, element } of [...update.changed].sort((a, b) => a.index - b.index)) {
        const at = next.findIndex((candidate) => candidate.id === element.id);
        if (at >= 0) next[at] = element;
        else if (index >= next.length) next.push(element);
        else next.splice(index, 0, element);
      }
      return {
        ...base,
        elements: next,
        ...(update.document === undefined ? {} : { document: update.document }),
      };
    }
    case "state":
      return { ...base, state: update.state };
    case "closed":
      return { ...base, state: update.state, closed: true };
    default: {
      // EXHAUSTIVE, not a fallthrough. A `default:` that settled the board would make a
      // fifth update kind — added upstream and not yet understood here — silently CLOSE
      // every board it touched, handing the reveal back to the durable read mid-draft with
      // nothing saying why. An unknown kind advances the revision and changes nothing else,
      // which is the honest reading of a frame this client cannot interpret.
      const exhaustive: never = update;
      void exhaustive;
      return base;
    }
  }
}

/**
 * The drafting snapshot for one `(generation, lens)`: the catch-up read, with every live
 * frame folded into the SAME cache entry, so a component reads one value and never a
 * read plus a second event state.
 */
export function useLensDraft(
  reviewId: string,
  generation: string,
  lens: LensKind,
): LiveDraft | undefined {
  const enabled = reviewId.length > 0 && generation.length > 0;
  const input = { reviewId, generation, lens };
  const { data } = useCommand("board.draft", input, { enabled });
  useCommandStream({
    channel: "lensDraft",
    subscriptionKey: enabled ? reviewId : undefined,
    command: { name: "board.draft", input },
    // A DELTA, not a snapshot: each frame carries one call's writes and is merged with
    // whatever the read left, rather than replacing it.
    delivery: "delta",
    fold: (prev, event) => ({
      draft: foldLensDraft(prev?.draft ?? undefined, event, { generation, lens }) ?? null,
    }),
  });
  return data?.draft ?? undefined;
}

export type LensDrafts = Readonly<Record<LensKind, LiveDraft | undefined>>;

/** Every lens's drafting snapshot at once. Written out so each hook is a top-level call
 *  in a fixed order; the `Record<LensKind, …>` annotation is the drift guard. */
export function useLensDrafts(reviewId: string, generation: string): LensDrafts {
  return {
    design: useLensDraft(reviewId, generation, "design"),
    sequence: useLensDraft(reviewId, generation, "sequence"),
    decisions: useLensDraft(reviewId, generation, "decisions"),
    flagged: useLensDraft(reviewId, generation, "flagged"),
    noise: useLensDraft(reviewId, generation, "noise"),
  };
}

/**
 * The drafting snapshot as a `LensBoard` the board document can render — the same shape
 * `board.read` serves, projected through `@rennet/protocol`'s own `projectBoardSections`,
 * which is the derivation the daemon runs over the persisted copy. One derivation, two
 * readers: a board that folded one way while it was written and another once it settled
 * would reorganise itself under the reviewer at the moment the lane settled.
 *
 * `boardId` is the drafting address rather than the durable board id, which the stream
 * does not carry. It is only ever a React key and a fold-state key here, and it is stable
 * for the life of the draft, which is what those two uses need. When the lane closes the
 * durable board takes over with its real id and the document remounts — correctly, since
 * that is a different copy of the board with the marks stamped on.
 */
export function draftAsBoard(draft: LiveDraft): LensBoard {
  return {
    lens: draft.lens,
    generation: draft.generation,
    boardId: `draft:${draft.generation}:${draft.lens}`,
    document: resolveBoardDocument(draft.lens, draft.document),
    sections: projectBoardSections(draft.elements),
    elements: draft.elements,
  } as LensBoard;
}

/** Whether this lens has a live board worth rendering over the durable one: a draft that
 *  is open, has arrived, and holds something. A closed draft is the durable copy's job. */
export function liveBoardFor(draft: LiveDraft | undefined): LensBoard | undefined {
  if (draft === undefined || draft.closed) return undefined;
  if (draft.elements.length === 0) return undefined;
  return draftAsBoard(draft);
}

/** Every lens's live board, or `undefined` where the durable read should be shown. */
export function liveBoards(drafts: LensDrafts): Readonly<Record<LensKind, LensBoard | undefined>> {
  return Object.fromEntries(LENS_KINDS.map((lens) => [lens, liveBoardFor(drafts[lens])])) as Record<
    LensKind,
    LensBoard | undefined
  >;
}
