import {
  LENS_KINDS,
  type LensAbsenceReason,
  type LensBoard,
  LensBoardSchema,
  type LensFailureAccount,
  type LensKind,
} from "@rennet/protocol";
import { useCommand } from "../data";
import { useRoundState } from "../rounds/rounds-data";
import {
  type GenerationLanes,
  type LensSeatState,
  type LensSeatStates,
  lensSeatStates,
} from "./lens-seats";
import { BOARD_EXCLUDED_KINDS } from "./registry";

const excludedKinds: ReadonlySet<string> = new Set(BOARD_EXCLUDED_KINDS);

// ─────────────────────────────────────────────────────────────────────────────
// The board-fetch seam (C05, Reconciliation 1) — the SINGLE point every
// board-rendering component resolves a `LensBoard` through, mirroring C3's
// `sidebar-data.ts` and C4's `citations.ts`. The client never invents board shape
// locally: whatever the seam returns is parsed against `LensBoardSchema`, and a
// shape that fails surfaces as `error` DATA, never a thrown render.
//
// The board arrives over `board.read` (registered + bound in C18): the host serves
// the PERSISTED board for a `(reviewId, generation, lens)` triple from the whiteboard
// event log the lens pipeline wrote. `board: null` is the honest missing answer for a
// lens that drafted no board that generation, and a read that FAILS is `invalid`
// (`unreadable`) — never folded into "no board yet".
// ─────────────────────────────────────────────────────────────────────────────

/** The `(generation, lens)` pair a resolution was requested for — what the returned
 *  board's own identity must match. */
export interface BoardIdentity {
  readonly generation: string;
  readonly lens: LensKind;
}

/**
 * Why a board resolved `invalid` — four honest failure modes, none of which may
 * render as "no board yet" (that lie is finding 1). `shape`: the source returned data
 * `LensBoardSchema` rejected. `identity`: it returned a well-formed board for the WRONG
 * `(generation, lens)` — a stale or cross-wired read, not the board asked for.
 * `excluded-kind`: it carries a host kind no lens board renders (`round_outcome` /
 * `review_comment`, finding 4) — the spike's silent-hole defect, caught as data.
 * `unreadable`: the read itself failed (the host could not serve this board).
 */
export type BoardInvalidReason = "shape" | "identity" | "excluded-kind" | "unreadable";

/**
 * The resolution of one `(generation, lens)` board request — a discriminated union so
 * an invalid board can never be mistaken for a missing one. `valid`: a board whose
 * shape AND identity check out and that carries only renderable kinds. `missing`: the
 * host has no board for this pair (absent-not-disabled). `pending`: the read is still
 * in flight — not yet an answer, so it is never rendered as absence. `invalid`: the
 * read answered, but with something wrong — surfaced as an honest error, never as empty.
 */
export type BoardResolution =
  | { readonly status: "valid"; readonly board: LensBoard }
  | { readonly status: "absent"; readonly reason: LensAbsenceReason }
  | {
      readonly status: "failed";
      readonly reason: string;
      /** The typed account when the host recorded one; absent means the classification
       *  is unknown, which is NOT the same as terminal. */
      readonly account?: LensFailureAccount;
    }
  | { readonly status: "missing" }
  | { readonly status: "pending" }
  | { readonly status: "invalid"; readonly reason: BoardInvalidReason; readonly detail: unknown };

/**
 * Parse raw board data against `LensBoardSchema` AND prove it is the board that was
 * asked for. The pure core of the seam — the client never trusts board shape OR
 * identity it did not validate: a shape failure, a lens/generation mismatch, or an
 * excluded kind each resolves `invalid` (rendered distinctly), separate from `missing`.
 */
export function resolveBoard(raw: unknown, expected: BoardIdentity): BoardResolution {
  if (raw === undefined || raw === null) return { status: "missing" };
  const parsed = LensBoardSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", reason: "shape", detail: parsed.error };
  const board = parsed.data;
  if (board.lens !== expected.lens || board.generation !== expected.generation) {
    return {
      status: "invalid",
      reason: "identity",
      detail: { expected, got: { lens: board.lens, generation: board.generation } },
    };
  }
  const excluded = board.elements.find((el) => excludedKinds.has(el.kind));
  if (excluded) {
    return { status: "invalid", reason: "excluded-kind", detail: excluded.kind };
  }
  return { status: "valid", board };
}

/** Fold one `board.read` result into a {@link BoardResolution}: a rejected read is an
 *  honest `unreadable`, an in-flight read is `pending`, and anything served routes
 *  through {@link resolveBoard} so shape and identity are still proven client-side. */
function resolveRead(
  result: {
    data?: {
      board: LensBoard | null;
      absence?: LensAbsenceReason;
      failure?: string;
      failureAccount?: LensFailureAccount;
    };
    error: unknown;
    pending: boolean;
  },
  expected: BoardIdentity,
): BoardResolution {
  if (result.error !== undefined && result.error !== null) {
    return { status: "invalid", reason: "unreadable", detail: result.error };
  }
  if (result.pending) return { status: "pending" };
  if (result.data?.board == null && result.data?.absence !== undefined) {
    return { status: "absent", reason: result.data.absence };
  }
  if (result.data?.board == null && result.data?.failure !== undefined) {
    const account = result.data.failureAccount;
    return {
      status: "failed",
      reason: result.data.failure,
      ...(account === undefined ? {} : { account }),
    };
  }
  return resolveBoard(result.data?.board, expected);
}

/**
 * Resolve the `LensBoard` for a `(generation, lens)` pair — the one hook every board
 * component reads. Any generation id resolves, so passing a FROZEN generation's id is
 * the generation drill-down read (C05 6.3); the current generation is just the live
 * one. One `board.read` per pair, validated against the requested identity, so a stale
 * or malformed board is `invalid`, not a crash and not a lie.
 */
export function useBoardData(
  reviewId: string,
  generation: string,
  lens: LensKind,
): BoardResolution {
  // With no review or generation to read against there is nothing to ask for: the read
  // stays disabled and resolves honest-missing rather than pending on a fetch never made.
  const enabled = reviewId.length > 0 && generation.length > 0;
  return resolveRead(useCommand("board.read", { reviewId, generation, lens }, { enabled }), {
    generation,
    lens,
  });
}

/**
 * One lens's row on the rail: its seat's state, always, plus whatever result the board
 * read has for it — a board, a typed absence, a failure, or nothing yet.
 *
 * `seat` is on EVERY arm because the rail now lists all five lenses from the first frame
 * (lens-board-tools D12), and the state of a lens with no result yet is the whole point
 * of it being there. The fourth, result-less arm is what that added: before this change
 * a lens with no terminal result was dropped from the list entirely.
 */
export type LensBoardEntry = {
  readonly lens: LensKind;
  readonly seat: LensSeatState;
} & (
  | { readonly board: LensBoard; readonly failure?: never; readonly absence?: never }
  | { readonly board?: never; readonly failure?: never; readonly absence: LensAbsenceReason }
  | { readonly board?: never; readonly failure: string; readonly absence?: never }
  | { readonly board?: never; readonly failure?: never; readonly absence?: never }
);

/**
 * Every lens's board read in `generation`. Probes every lens through the one seam and
 * keeps populated, typed-empty, and failed results, so "which lenses have settled" is
 * derived from board-data, never invented. `LENS_KINDS` is fixed-length, so the per-lens
 * reads are hooks-safe.
 */
export type LensBoardResolutions = Readonly<Record<LensKind, BoardResolution>>;

/** Resolve every fixed lens exactly once so callers can distinguish settled absence. */
export function useLensBoardResolutions(
  reviewId: string,
  generation: string,
): LensBoardResolutions {
  // One read per lens, written out so every hook is a top-level call in a fixed order.
  // The `Record<LensKind, …>` annotation is the drift guard: a lens added to `LENS_KINDS`
  // fails to compile here until it gets its read.
  return {
    design: useBoardData(reviewId, generation, "design"),
    sequence: useBoardData(reviewId, generation, "sequence"),
    decisions: useBoardData(reviewId, generation, "decisions"),
    flagged: useBoardData(reviewId, generation, "flagged"),
    noise: useBoardData(reviewId, generation, "noise"),
  };
}

/**
 * The rail, from the board reads and the generation's lanes: ALL FIVE lenses, in canonical
 * order, each carrying its seat's state (lens-board-tools 5.1, D12).
 *
 * WHAT CHANGED AND WHY, because it reverses a rule that was deliberate. Until this change a
 * lens with no terminal result was omitted, and a Design lane that settled `no-spec` was
 * omitted too (session-bound-workspace D6: there is nothing to open). Both omissions are
 * gone, for one reason each:
 *
 *  • `live-board-workspace` requires all five listed "from the moment the generation starts,
 *    whether or not a lens has a result", because a running lens has to be selectable —
 *    that is the whole of "boards first".
 *  • A lens that appears and then DISAPPEARS as it settles breaks the same spec's "nothing
 *    navigates when a lane settles": the reviewer's selected tab would vanish under them.
 *    `no-spec` Design is exactly that case, and the wireframe draws an absent lens IN the
 *    rail (`— absent`) rather than out of it.
 *
 * The `no-spec` board is not empty: `BoardAccount` renders the absence's own words, which is
 * what the tab now opens onto. Callers that need "which lenses actually have something to
 * read" — the selected-lens fallback — ask {@link lensesWithResult}, not this list's length.
 */
export function lensBoardsFromResolutions(
  byLens: LensBoardResolutions,
  seats: LensSeatStates,
): LensBoardEntry[] {
  return LENS_KINDS.map<LensBoardEntry>((lens) => {
    const resolution = byLens[lens];
    const seat = seats[lens];
    if (resolution.status === "valid") return { lens, seat, board: resolution.board };
    if (resolution.status === "absent") return { lens, seat, absence: resolution.reason };
    if (resolution.status === "failed") return { lens, seat, failure: resolution.reason };
    return { lens, seat };
  });
}

/** The entries that have something to open — a board, a typed absence, or a failure. The
 *  selected-lens fallback reads THIS, so a rail that now lists a result-less lens cannot
 *  make it the fallback target. */
export function lensesWithResult(entries: readonly LensBoardEntry[]): LensBoardEntry[] {
  return entries.filter(
    (entry) =>
      entry.board !== undefined || entry.absence !== undefined || entry.failure !== undefined,
  );
}

/** Whether every lens has reached a durable or terminal read result. */
export function lensReadsSettled(byLens: LensBoardResolutions): boolean {
  return Object.values(byLens).every(
    (resolution) => resolution.status !== "missing" && resolution.status !== "pending",
  );
}

/**
 * The generation's lanes AND whether it is still going — what the rail, the widget and the
 * drawer all read their seat states from.
 *
 * TWO sources, because a generation has two shapes and only one of them is in flight at a
 * time: `session.preparation` for the initial generation (the daemon's durable preparation
 * record) and the round machine's state for a post-round regeneration. The round state
 * wins when it has lanes, because a regeneration is the later generation.
 *
 * `running` IS THE FIELD THAT MATTERS, and it is read off the record's own status rather
 * than inferred from the lanes. `SessionPreparation` makes `lanes` optional on BOTH
 * terminal arms: a cancel during capture writes `{status:"cancelled", stage:"capture"}`
 * with no lanes at all, and a cancel during drafting keeps the lanes frozen at whatever
 * status they held. Neither is a running generation, and treating "no lanes key" as "in
 * flight, lanes not opened yet" is what made a cancelled review say its seats were still
 * writing.
 *
 * `undefined` means there is no generation record here at all — an old review, a frozen
 * generation drill-down — and every lens is answered for by its board read.
 */
export function useGenerationLanes(slug: string): GenerationLanes | undefined {
  const { data } = useCommand("session.list", {}, { enabled: slug.length > 0 });
  const roundState = useRoundState(slug);
  const roundLanes = "lanes" in roundState ? roundState.lanes : undefined;
  if (roundLanes !== undefined && roundLanes.length > 0) {
    // A regeneration is running while it is composing or verifying. `composed` carries its
    // lanes forward so the block does not blink out at the moment it finishes — which is
    // exactly the case that must not read as live.
    const phase = roundState.phase;
    return { lanes: roundLanes, running: phase === "composing" || phase === "verifying" };
  }
  const preparation = data?.sessions.find((candidate) => candidate.id === slug)?.preparation;
  if (preparation === undefined) return undefined;
  const running = preparation.status === "capturing" || preparation.status === "drafting";
  // `capturing` has no lanes at all, and that is honest: the daemon has not opened one. It
  // is still a RUNNING generation, so the rail lists five queued lenses — but no lane means
  // no board of any of them is being written, which `lens-seats.ts` is what enforces.
  return { lanes: "lanes" in preparation ? (preparation.lanes ?? []) : [], running };
}

/** Every lens's seat state for the generation the session is on. */
export function useLensSeats(slug: string, resolutions: LensBoardResolutions): LensSeatStates {
  const lanes = useGenerationLanes(slug);
  return lensSeatStates(lanes, resolutions);
}

export function useLensBoards(
  slug: string,
  reviewId: string,
  generation: string,
): LensBoardEntry[] {
  const resolutions = useLensBoardResolutions(reviewId, generation);
  return lensBoardsFromResolutions(resolutions, useLensSeats(slug, resolutions));
}
