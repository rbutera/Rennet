import { join } from "node:path";
import {
  APP_OWNED_BOARD_SEGMENTS,
  BOARD_WIRE_SCHEMA,
  type BoardEventFrame,
} from "@rennet/protocol";
import { BoardService, type BoardStore } from "@wboard/server";
import { FileBoardStore } from "./file-board-store";

/** Receives the events a successful apply just appended (B4 broadcast hook). */
export type BoardEventsListener = (boardId: string, events: BoardEventFrame["events"]) => void;

/**
 * The boards runtime: one embedded {@link BoardService} over a
 * {@link FileBoardStore} rooted at `.rennet/boards/` under the review project —
 * local, and never Rennet's to stage or commit.
 *
 * It is NOT kept out of reviews by an ignore rule. That claim used to stand here and
 * it was false (#729): plenty of repositories do not ignore `.rennet/`, and in those
 * the board this runtime wrote landed in the next capture and invalidated the very
 * review it belonged to. What keeps it out is that capture, the repo watcher and
 * freshness all exclude the prefix this store is rooted at, from the shared
 * `APP_OWNED_BOARD_SEGMENTS` authority joined below — so the exclusion holds whatever
 * the user's `.gitignore` says, and Rennet never writes an ignore rule into their repo.
 *
 * No freeze/generation policy lives here (append-then-freeze is #457
 * lifecycle, owned by B8/B9). Broadcast: `onEvents` observes the store's
 * `append` — the single write choke point every accepted op crosses — so
 * whoever wires the runtime (create-server) can fan events to live clients.
 */
export interface BoardsRuntime {
  /** The embedded board service — reads for anyone, writes only via whiteboard-client. */
  readonly service: BoardService;
  /** Mint a board declared with the Rennet host wire schema; returns the board id.
   * A caller-owned id makes a durable drafting attempt restartable: the same attempt
   * adopts the same empty or partially-written board instead of minting a second one. */
  createRennetBoard(boardId?: string): Promise<string>;
}

/** Construct the runtime for one review project rooted at `projectRoot`. */
export function createBoardsRuntime(
  projectRoot: string,
  onEvents?: BoardEventsListener,
): BoardsRuntime {
  // The store's location comes from the shared app-owned-paths authority, not a literal:
  // capture, the watcher and freshness exclude exactly what this joins (#729, D6).
  const store = new FileBoardStore(join(projectRoot, ...APP_OWNED_BOARD_SEGMENTS));
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
    createRennetBoard: async (boardId?: string) => {
      if (boardId === undefined) return service.createBoard(BOARD_WIRE_SCHEMA);
      const existing = await store.getSchema(boardId);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(BOARD_WIRE_SCHEMA)) {
          throw new Error(`board schema does not match the Rennet schema: ${boardId}`);
        }
        return boardId;
      }
      await store.createBoard(boardId, BOARD_WIRE_SCHEMA);
      return boardId;
    },
  };
}
