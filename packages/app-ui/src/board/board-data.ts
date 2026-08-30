import {
  LENS_KINDS,
  type LensAbsenceReason,
  type LensBoard,
  LensBoardSchema,
  type LensKind,
} from "@rennet/protocol";
import { useCommand } from "../data";
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
  | { readonly status: "failed"; readonly reason: string }
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
    data?: { board: LensBoard | null; absence?: LensAbsenceReason; failure?: string };
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
    return { status: "failed", reason: result.data.failure };
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

/** A generated or failed lens — every terminal result the lens switcher can open. */
export type LensBoardEntry =
  | { readonly lens: LensKind; readonly board: LensBoard; readonly failure?: never }
  | { readonly lens: LensKind; readonly board?: never; readonly failure: string };

/**
 * The lenses that HAVE a board in `generation`, each with its board — the lens
 * switcher's absent-not-disabled set (C05 6.2). Probes every lens through the one
 * seam and keeps only those that resolve, so "which lenses are present" is derived
 * from board-data, never invented: a lens the host has no board for is simply
 * absent. `LENS_KINDS` is fixed-length, so the per-lens reads are hooks-safe.
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

export function lensBoardsFromResolutions(byLens: LensBoardResolutions): LensBoardEntry[] {
  return LENS_KINDS.flatMap<LensBoardEntry>((lens) => {
    const resolution = byLens[lens];
    if (resolution.status === "valid") return [{ lens, board: resolution.board }];
    if (resolution.status === "failed") return [{ lens, failure: resolution.reason }];
    return [];
  });
}

/** Whether every lens has reached a durable or terminal read result. */
export function lensReadsSettled(byLens: LensBoardResolutions): boolean {
  return Object.values(byLens).every(
    (resolution) => resolution.status !== "missing" && resolution.status !== "pending",
  );
}

export function useLensBoards(reviewId: string, generation: string): LensBoardEntry[] {
  return lensBoardsFromResolutions(useLensBoardResolutions(reviewId, generation));
}
