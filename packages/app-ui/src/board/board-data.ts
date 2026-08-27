import { type LensBoard, LensBoardSchema, type LensKind } from "@rennet/protocol";
import { createContext, useContext } from "react";

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

/** The resolution of one `(generation, lens)` board request. Exactly one of the three
 *  states holds: a valid `board`, `missing` (no board for this pair), or `error`
 *  (the source returned a shape `LensBoardSchema` rejected — data, never a throw). */
export interface BoardResolution {
  readonly board: LensBoard | undefined;
  readonly missing: boolean;
  readonly error: unknown;
}

/** Parse raw board data against `LensBoardSchema`. The pure core of the seam — the
 *  client never trusts board shape it did not validate. */
export function resolveBoard(raw: unknown): BoardResolution {
  if (raw === undefined) return { board: undefined, missing: true, error: undefined };
  const parsed = LensBoardSchema.safeParse(raw);
  return parsed.success
    ? { board: parsed.data, missing: false, error: undefined }
    : { board: undefined, missing: false, error: parsed.error };
}

/**
 * Resolve the `LensBoard` for a `(generation, lens)` pair — the one hook every board
 * component reads. Any generation id resolves, so passing a FROZEN generation's id is
 * the generation drill-down read (C05 6.3); the current generation is just the live
 * one. Reads the context source and validates its result, so a bad board is `error`,
 * not a crash.
 */
export function useBoardData(generation: string, lens: LensKind): BoardResolution {
  const source = useContext(BoardSourceContext);
  return resolveBoard(source(generation, lens));
}
