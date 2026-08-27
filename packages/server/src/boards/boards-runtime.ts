import { join } from "node:path";
import { BOARD_WIRE_SCHEMA, type BoardEventFrame } from "@rennet/protocol";
import { BoardService, type BoardStore } from "@wboard/server";
import { FileBoardStore } from "./file-board-store";

/** Receives the events a successful apply just appended (B4 broadcast hook). */
export type BoardEventsListener = (boardId: string, events: BoardEventFrame["events"]) => void;

/**
 * The boards runtime: one embedded {@link BoardService} over a
 * {@link FileBoardStore} rooted at `.rennet/boards/` under the review
 * project — local, never staged (`.rennet/` is ignored by default;
 * verified against the repo `.gitignore`).
 *
 * No freeze/generation policy lives here (append-then-freeze is #457
 * lifecycle, owned by B8/B9). Broadcast: `onEvents` observes the store's
 * `append` — the single write choke point every accepted op crosses — so
 * whoever wires the runtime (create-server) can fan events to live clients.
 */
export interface BoardsRuntime {
  /** The embedded board service — reads for anyone, writes only via whiteboard-client. */
  readonly service: BoardService;
  /** Mint a board declared with the Rennet host wire schema; returns the board id. */
  createRennetBoard(): Promise<string>;
}

/** Construct the runtime for one review project rooted at `projectRoot`. */
export function createBoardsRuntime(
  projectRoot: string,
  onEvents?: BoardEventsListener,
): BoardsRuntime {
  const store = new FileBoardStore(join(projectRoot, ".rennet", "boards"));
  // Observe append rather than wrapping `BoardService.apply`: append returns the
  // events WITH their assigned seqs, and it is the one path every write takes.
  const observed: BoardStore = !onEvents
    ? store
    : {
        createBoard: (boardId, schema) => store.createBoard(boardId, schema),
        getSchema: (boardId) => store.getSchema(boardId),
        getEvents: (boardId, afterSeq) => store.getEvents(boardId, afterSeq),
        append: async (boardId, entries) => {
          const events = await store.append(boardId, entries);
          if (events.length > 0) {
            try {
              onEvents(boardId, events as BoardEventFrame["events"]);
            } catch {
              // Post-commit notification must not poison a persisted apply:
              // the events are on disk, a dedup'd retry would emit nothing,
              // and the client would report failure for a committed write.
              // Live listeners re-sync via getEvents.
            }
          }
          return events;
        },
      };
  const service = new BoardService(observed);
  return {
    service,
    createRennetBoard: () => service.createBoard(BOARD_WIRE_SCHEMA),
  };
}
