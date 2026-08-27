import { LENS_KINDS, type LensBoard, LensBoardSchema, type LensKind } from "@rennet/protocol";
import { createContext, useContext } from "react";
import { BOARD_EXCLUDED_KINDS } from "./registry";

const excludedKinds: ReadonlySet<string> = new Set(BOARD_EXCLUDED_KINDS);

// ─────────────────────────────────────────────────────────────────────────────
// The board-fetch seam (C05, Reconciliation 1) — the SINGLE point every
// board-rendering component resolves a `LensBoard` through, mirroring C3's
// `sidebar-data.ts` and C4's `citations.ts`. The client never invents board shape
// locally: whatever the seam returns is parsed against `LensBoardSchema`, and a
// shape that fails surfaces as `error` DATA, never a thrown render.
//
// NO board-fetch command exists in the protocol yet — `commands/index.ts` registers
// no `lensBoard`/`board` name, and `useCommand<K>` is typed over registered
// `CommandName`, so it CANNOT name a command that does not exist. Registering it is
// B4/B10's declared job (`lens-board.ts`: "the command that returns it is B4/B10's
// business"). So today the board arrives through a `BoardSource` supplied on context
// — the same shape C3 used for its not-yet-a-command session projection
// (`SidebarSessionProjectionProvider`), because the MemoryBridge can only answer a
// REGISTERED command. Tests hand `fixtureBoardSource` to {@link BoardSourceProvider};
// the fixtures live behind the import fence (`test/fixtures/boards/`), never imported
// by a surface.
//
// When B4/B10 registers and binds the board command, {@link useBoardData}'s body
// becomes one `useCommand("<board command>", { generation, lens })` read and this
// context is deleted — the ONLY file that changes (gated cluster 8).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw board data for a `(generation, lens)` pair, or `undefined` when that lens has
 * no board that generation (absent-not-disabled — the lens switcher renders no
 * segment). Returns `unknown` on purpose: the seam OWNS validation, so a source can
 * hand back anything and {@link useBoardData} is the one place shape is proven.
 */
export type BoardSource = (generation: string, lens: LensKind) => unknown;

const BoardSourceContext = createContext<BoardSource>(() => undefined);

/** Supplies the board source (fixtures today; deleted when the live command lands). */
export const BoardSourceProvider = BoardSourceContext.Provider;

/** The `(generation, lens)` pair a resolution was requested for — what the returned
 *  board's own identity must match. */
export interface BoardIdentity {
  readonly generation: string;
  readonly lens: LensKind;
}

/**
 * Why a board resolved `invalid` — three honest failure modes, none of which may
 * render as "no board yet" (that lie is finding 1). `shape`: the source returned data
 * `LensBoardSchema` rejected. `identity`: it returned a well-formed board for the WRONG
 * `(generation, lens)` — a stale or cross-wired read, not the board asked for.
 * `excluded-kind`: it carries a host kind no lens board renders (`round_outcome` /
 * `review_comment`, finding 4) — the spike's silent-hole defect, caught as data.
 */
export type BoardInvalidReason = "shape" | "identity" | "excluded-kind";

/**
 * The resolution of one `(generation, lens)` board request — a discriminated union so
 * an invalid board can never be mistaken for a missing one. `valid`: a board whose
 * shape AND identity check out and that carries only renderable kinds. `missing`: the
 * source has no board for this pair (absent-not-disabled). `invalid`: the source
 * answered, but with something wrong — surfaced as an honest error, never as empty.
 */
export type BoardResolution =
  | { readonly status: "valid"; readonly board: LensBoard }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: BoardInvalidReason; readonly detail: unknown };

/**
 * Parse raw board data against `LensBoardSchema` AND prove it is the board that was
 * asked for. The pure core of the seam — the client never trusts board shape OR
 * identity it did not validate: a shape failure, a lens/generation mismatch, or an
 * excluded kind each resolves `invalid` (rendered distinctly), separate from `missing`.
 */
export function resolveBoard(raw: unknown, expected: BoardIdentity): BoardResolution {
  if (raw === undefined) return { status: "missing" };
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

/**
 * Resolve the `LensBoard` for a `(generation, lens)` pair — the one hook every board
 * component reads. Any generation id resolves, so passing a FROZEN generation's id is
 * the generation drill-down read (C05 6.3); the current generation is just the live
 * one. Reads the context source and validates its result against the requested
 * identity, so a stale or malformed board is `invalid`, not a crash and not a lie.
 */
export function useBoardData(generation: string, lens: LensKind): BoardResolution {
  const source = useContext(BoardSourceContext);
  return resolveBoard(source(generation, lens), { generation, lens });
}

/** A present lens paired with its resolved board — what the lens switcher renders. */
export interface LensBoardEntry {
  readonly lens: LensKind;
  readonly board: LensBoard;
}

/**
 * The lenses that HAVE a board in `generation`, each with its board — the lens
 * switcher's absent-not-disabled set (C05 6.2). Probes every lens through the one
 * seam and keeps only those that resolve, so "which lenses are present" is derived
 * from board-data, never invented: a lens the source has no board for is simply
 * absent. One `useContext`; the fixed-length `LENS_KINDS` map is pure, so this stays
 * hooks-safe.
 */
export function useLensBoards(generation: string): LensBoardEntry[] {
  const source = useContext(BoardSourceContext);
  return LENS_KINDS.flatMap((lens) => {
    const resolution = resolveBoard(source(generation, lens), { generation, lens });
    return resolution.status === "valid" ? [{ lens, board: resolution.board }] : [];
  });
}
