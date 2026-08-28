import { type LensBoard, LensBoardSchema, type RoundRecord } from "@rennet/protocol";
import { createContext, useContext, useMemo } from "react";
import { useRoute } from "wouter";
import { useCommand, useCommandStream, useMutation } from "../data";
import { ROUTES } from "../routes/url";
import { advance, initialRoundState, type RoundState } from "./round-machine";

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

/** The honest-absent default: no live round, an empty ledger, no report, no dispatch.
 *  Also the value the app tree binds today (`routes/app.tsx`) — an explicit provider node
 *  so the top-bar + routes read ONE source, and cluster 8 swaps this for the live runtime
 *  at the same seam without moving the provider. Wrapping with it changes no behavior now
 *  (it is the context default); it exists to give the live swap a home. */
export const ABSENT_ROUNDS_SOURCE: RoundsSource = {
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
 * Parse raw report-board data against `LensBoardSchema` — the pure core of the report read,
 * validated at the RUNTIME boundary (finding 4). The client never trusts report shape it did
 * not validate: a shape failure resolves `invalid` (rendered distinctly), separate from
 * `missing`. Two further runtime checks past the schema, because `LensBoardSchema` is a
 * structural shape and admits data outside the report's rendering domain:
 *
 *   - IDENTITY: the resolved board's `boardId` must equal the `expectedId` requested. A source
 *     that answers the wrong board (a cross-wire) is `invalid`, not silently rendered AS the
 *     selected report. (Unlike a lens board, a report is fetched by id, so id — not
 *     `(generation, lens)` — is the identity to check.)
 *   - REPORT DOMAIN: the report renders every lens kind PLUS `round_outcome`, but NOT
 *     `review_comment` — the one `HostKind` outside `ReportKind` (`BOARD_EXCLUDED_KINDS` minus
 *     `round_outcome`; `board/registry.ts`). A schema-valid board carrying a `review_comment`
 *     element parses fine but THROWS in `ReportElement` (`assertExcludedKind`); reject it here
 *     as `invalid` data so the render boundary never crashes.
 */
export function resolveReportBoard(raw: unknown, expectedId: string): ReportBoardResolution {
  if (raw === undefined) return { status: "missing" };
  const parsed = LensBoardSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", detail: parsed.error };
  const board = parsed.data;
  if (board.boardId !== expectedId) {
    return {
      status: "invalid",
      detail: `report id mismatch: expected ${expectedId}, got ${board.boardId}`,
    };
  }
  const excluded = board.elements.find((el) => el.kind === "review_comment");
  if (excluded !== undefined) {
    return {
      status: "invalid",
      detail: `report board carries a non-report kind: ${excluded.kind}`,
    };
  }
  return { status: "valid", board };
}

/** The live round machine state for a session — honest-absent by default. */
export function useRoundState(slug: string): RoundState {
  return useContext(RoundsSourceContext).roundState(slug);
}

/** The session's completed rounds, oldest→newest — empty (stable ref) by default. */
export function useRoundRecords(slug: string): readonly RoundRecord[] {
  return useContext(RoundsSourceContext).roundRecords(slug);
}

/** Resolve a report `LensBoard` by id, validated against `LensBoardSchema` plus the identity
 *  and report-domain checks (finding 4) — the requested id IS the expected id. */
export function useReportBoard(reportBoardId: string): ReportBoardResolution {
  return resolveReportBoard(
    useContext(RoundsSourceContext).reportBoard(reportBoardId),
    reportBoardId,
  );
}

/** The dispatch capability for the current source, or `undefined` when no live runtime
 *  is bound (⇒ C8's Dispatch button stays disabled — the truth today). Cluster 4 reads
 *  this and threads it to the handoff lanes. */
export function useRoundDispatch(): ((slug: string) => void) | undefined {
  return useContext(RoundsSourceContext).dispatch;
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE seam body (C15 3.2) — the swap C09 cluster 8 left a home for. The callers do
// not change; only the source does. The three reads resolve against the daemon:
//
//   • `roundState` — the `session.roundEvents` catch-up read with the `roundProgress`
//     push channel folded into the SAME cache entry (`useCommandStream`), then reduced
//     through `advance`. The rows advance on REAL events — the fixture clock is gone
//     from the app tree (the fixtures stay, for tests).
//   • `roundRecords` — the `session.rounds` ledger read.
//   • `dispatch` — the `round.dispatch` write, so the round exit actually kicks a round.
//
// `reportBoard` stays honestly absent: NO board-fetch command exists in the protocol
// (`commands/index.ts` registers none — it is B4/B10's declared job, and `board-data.ts`
// records the same gap for the lens boards). A source cannot invent a board it has no way
// to read, so the report resolves `missing` rather than a fabricated greeting.
// ─────────────────────────────────────────────────────────────────────────────

/** The session slug the current route is on, or `undefined` off a session route — the
 *  review id the round reads key on (`routes/slug.ts`: a slug IS a review id). */
function useCurrentSessionSlug(): string | undefined {
  const [onRun, runParams] = useRoute(ROUTES.sessionRun);
  const [onSession, sessionParams] = useRoute(ROUTES.session);
  if (onRun) return runParams?.slug;
  if (onSession) return sessionParams?.slug;
  return undefined;
}

/**
 * The live {@link RoundsSource} for whichever session the router is on. Bound once, above
 * the route switch (`routes/app.tsx`), so the top bar and both session routes read ONE
 * source — the provider does not move, only its value.
 */
export function useLiveRoundsSource(): RoundsSource {
  const slug = useCurrentSessionSlug();
  const enabled = slug !== undefined;
  const reviewId = slug ?? "";
  const eventsCommand = { name: "session.roundEvents" as const, input: { reviewId } };

  const { data: eventsData } = useCommand(eventsCommand.name, eventsCommand.input, { enabled });
  // The live push, folded into the read's own cache entry. A `dispatched` event STARTS a
  // round, so it resets the log exactly as the server's hub does — a second dispatch must
  // not replay the first round's composed state.
  // ponytail: an event that lands between the catch-up read being issued and its response
  // populating the entry is dropped (the response overwrites the entry). The events are
  // snapshots and the machine is forward-only, so the visible cost is a momentarily stale
  // row at mount; the fix is a seq-guarded merge like `chat-data`'s, worth it only if a
  // dropped terminal event is ever actually observed.
  useCommandStream({
    channel: "roundProgress",
    subscriptionKey: slug,
    command: eventsCommand,
    fold: (prev, event) => ({
      events: event.type === "dispatched" ? [event] : [...(prev?.events ?? []), event],
    }),
  });

  const { data: recordsData } = useCommand("session.rounds", { reviewId }, { enabled });
  const { mutate } = useMutation("round.dispatch", {
    invalidates: ["session.rounds", "session.roundEvents"],
  });

  const events = eventsData?.events;
  const records = recordsData?.records;
  return useMemo(() => {
    // The machine IS the fold: the same reducer the daemon's events were designed for,
    // over the same events a late-joining client catches up on. No wall clock anywhere.
    const state = (events ?? []).reduce(advance, initialRoundState);
    return {
      roundState: (forSlug: string) => (forSlug === slug ? state : initialRoundState),
      roundRecords: (forSlug: string) => (forSlug === slug ? (records ?? NO_RECORDS) : NO_RECORDS),
      reportBoard: () => undefined,
      dispatch: (forSlug: string) => {
        void mutate({ reviewId: forSlug }).catch(() => undefined);
      },
    };
  }, [events, records, slug, mutate]);
}
