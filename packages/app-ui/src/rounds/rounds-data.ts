import { type LensBoard, LensBoardSchema, type RoundRecord } from "@rennet/protocol";
import { createContext, useContext } from "react";
import { initialRoundState, type RoundState } from "./round-machine";

// ─────────────────────────────────────────────────────────────────────────────
// The rounds-data seam (C09 §1.2) — the SINGLE point every rounds surface resolves its
// three reads through, mirroring C05's `board/board-data.ts` exactly. The client never
// invents round shape locally: the live {@link RoundState}, the completed
// {@link RoundRecord}s, and the report board each arrive through a {@link RoundsSource}
// on context, and the report board is parsed against `LensBoardSchema` before any
// surface renders it.
//
// NO rounds runtime exists in the protocol/core/adapters/server yet (Reconciliation 1):
// no round-dispatch command, no round-state read, no round-progress channel is
// registered. So today the source is honest-absent by default — no dispatchable round,
// an empty ledger, no report — which is the TRUTH of a build with no live rounds. Tests
// and dev hand a fixture {@link RoundsSource} to {@link RoundsSourceProvider}; the
// fixtures live behind the import fence (`test/fixtures/rounds/`), never imported by a
// surface.
//
// When B9 registers + binds the rounds runtime, this seam's BODIES swap (cluster 8):
// `roundState` folds a `useCommandStream` round-progress channel through `advance`,
// `roundRecords`/`reportBoard` become `useCommand` reads, and `dispatch` resolves the
// real round-dispatch command — the callers do not change, only the source.
// ─────────────────────────────────────────────────────────────────────────────

/** A shared frozen empty ledger — a STABLE reference, so the honest-absent source does
 *  not hand back a fresh array per render (the Zustand/re-render trap C09 warns of). */
const NO_RECORDS: readonly RoundRecord[] = Object.freeze([]);

/**
 * The three reads (plus dispatch) every rounds surface resolves through. `reportBoard`
 * returns `unknown` on purpose: the seam OWNS validation, so a source hands back
 * whatever it has and {@link useReportBoard} is the one place report shape is proven.
 * `dispatch` is absent over the honest-absent source (no live runtime) ⇒ C8's Dispatch
 * button stays disabled; cluster 4 threads it through the workspace.
 */
export interface RoundsSource {
  /** The live round machine state for a session (honest-absent by default). */
  readonly roundState: (slug: string) => RoundState;
  /** The session's completed rounds, oldest→newest (empty when none). */
  readonly roundRecords: (slug: string) => readonly RoundRecord[];
  /** Raw report-board data by id, or `undefined` when the id resolves nothing. */
  readonly reportBoard: (reportBoardId: string) => unknown;
  /** Dispatch a work-order round for `slug`; absent ⇒ no live runtime, button disabled. */
  readonly dispatch?: (slug: string) => void;
}

/** The honest-absent default: no live round, an empty ledger, no report, no dispatch. */
const ABSENT_ROUNDS_SOURCE: RoundsSource = {
  roundState: () => initialRoundState,
  roundRecords: () => NO_RECORDS,
  reportBoard: () => undefined,
};

const RoundsSourceContext = createContext<RoundsSource>(ABSENT_ROUNDS_SOURCE);

/** Supplies the rounds source (fixtures today; swapped to the live runtime at cluster 8). */
export const RoundsSourceProvider = RoundsSourceContext.Provider;

/**
 * The resolution of a report-board request. A report board is a `LensBoard` fetched by
 * id, so — unlike a lens board — it carries `round_outcome` items (its whole point) and
 * is NOT identity-checked against a `(generation, lens)` pair. `valid`: shape passed
 * `LensBoardSchema`. `missing`: the source has no board for this id. `invalid`: the
 * source answered with something the schema rejected — an honest error, never "no round".
 */
export type ReportBoardResolution =
  | { readonly status: "valid"; readonly board: LensBoard }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly detail: unknown };

/**
 * Parse raw report-board data against `LensBoardSchema` — the pure core of the report
 * read. The client never trusts report shape it did not validate: a shape failure
 * resolves `invalid` (rendered distinctly), separate from `missing`. No excluded-kind
 * rejection here (the report board is exactly where `round_outcome` renders) and no
 * identity check (it is fetched by id, not by generation/lens).
 */
export function resolveReportBoard(raw: unknown): ReportBoardResolution {
  if (raw === undefined) return { status: "missing" };
  const parsed = LensBoardSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", detail: parsed.error };
  return { status: "valid", board: parsed.data };
}

/** The live round machine state for a session — honest-absent by default. */
export function useRoundState(slug: string): RoundState {
  return useContext(RoundsSourceContext).roundState(slug);
}

/** The session's completed rounds, oldest→newest — empty (stable ref) by default. */
export function useRoundRecords(slug: string): readonly RoundRecord[] {
  return useContext(RoundsSourceContext).roundRecords(slug);
}

/** Resolve a report `LensBoard` by id, validated against `LensBoardSchema`. */
export function useReportBoard(reportBoardId: string): ReportBoardResolution {
  return resolveReportBoard(useContext(RoundsSourceContext).reportBoard(reportBoardId));
}

/** The dispatch capability for the current source, or `undefined` when no live runtime
 *  is bound (⇒ C8's Dispatch button stays disabled — the truth today). Cluster 4 reads
 *  this and threads it to the handoff lanes. */
export function useRoundDispatch(): ((slug: string) => void) | undefined {
  return useContext(RoundsSourceContext).dispatch;
}
