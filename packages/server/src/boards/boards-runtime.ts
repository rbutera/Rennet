import { join } from "node:path";
import { BOARD_WIRE_SCHEMA } from "@rennet/protocol";
import { BoardService } from "@wboard/server";
import { FileBoardStore } from "./file-board-store";

/**
 * The boards runtime: one embedded {@link BoardService} over a
 * {@link FileBoardStore} rooted at `.rennet/boards/` under the review
 * project — local, never staged (`.rennet/` is ignored by default;
 * verified against the repo `.gitignore`).
 *
 * No freeze/generation policy lives here (append-then-freeze is #457
 * lifecycle, owned by B8/B9) and no transport — broadcast wiring is the
 * privacy-seam cluster's business.
 */
export interface BoardsRuntime {
  /** The embedded board service — reads for anyone, writes only via whiteboard-client. */
  readonly service: BoardService;
  /** Mint a board declared with the Rennet host wire schema; returns the board id. */
  createRennetBoard(): Promise<string>;
}

/** Construct the runtime for one review project rooted at `projectRoot`. */
export function createBoardsRuntime(projectRoot: string): BoardsRuntime {
  const service = new BoardService(new FileBoardStore(join(projectRoot, ".rennet", "boards")));
  return {
    service,
    createRennetBoard: () => service.createBoard(BOARD_WIRE_SCHEMA),
  };
}
