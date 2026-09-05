// Which board address a seat thread is given (`lens-board-tools` 2.6).
//
// A seat is a THREAD and a target is a BOARD, and the two are not the same thing: the
// Flagged lane runs two seats over one board. So the seat's address is looked up through
// `SEAT_BOARD_TARGET`, never by reading the seat name as a target — which would leave both
// Flagged seats addressing a `flagged-claude`/`flagged-codex` board that does not exist.
//
// Lives beside the board server rather than inside `create-server.ts` so the mapping is
// something a test can drive; the composition root calls this and does nothing else.

import { SEAT_BOARD_TARGET, SEAT_BOARD_VOICE, SEAT_KINDS, type SeatKind } from "../t3/threads";
import type { GenerationBoards, SeatBoardServer } from "./board-mcp-server";

/**
 * This seat's address onto its lane's board, minted on the seat's first turn and refreshed
 * on every later one.
 *
 * `undefined` when the generation has no board server, when the seat's lane is not open, or
 * when the seat is not one this daemon knows — and the turn then names no server at all,
 * rather than an address that resolves to nothing.
 */
export function seatBoardServer(
  boards: GenerationBoards | undefined,
  seat: string,
): SeatBoardServer | undefined {
  if (boards === undefined) return undefined;
  if (!(SEAT_KINDS as readonly string[]).includes(seat)) return undefined;
  const kind = seat as SeatKind;
  return boards.lane(SEAT_BOARD_TARGET[kind])?.address({ seat, ...SEAT_BOARD_VOICE[kind] });
}
