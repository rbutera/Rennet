import {
  type RoundEvent,
  type RoundLedgerRecord,
  type RoundReportBoard,
  RoundReportBoardSchema,
} from "@rennet/protocol";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { commandKey, useCommand, useCommandStream, useMutation } from "../data";
import { useBridgeContext } from "../data/bridge";
import { reviewIdOf, useSlugResolution } from "../routes/slug";
import { ROUTES } from "../routes/url";
import { advance, initialRoundState, mergeRoundEvents, type RoundState } from "./round-machine";

// ─────────────────────────────────────────────────────────────────────────────
// The rounds-data seam (C09 §1.2) — the SINGLE point every rounds surface resolves its
// three reads through, mirroring C05's `board/board-data.ts` exactly. The client never
// invents round shape locally: the live {@link RoundState}, the completed
// {@link RoundLedgerRecord}s, and the report board each arrive through a {@link RoundsSource}
// on context, and the report board is parsed against `RoundReportBoardSchema` before any
// surface renders it.
//
// The rounds runtime IS registered and bound (`round.dispatch`, `session.roundEvents`,
// `session.rounds`, the `roundProgress` channel), and {@link useLiveRoundsSource} below is
// what the app tree binds — see the LIVE SEAM BODY section. The CONTEXT DEFAULT stays
// honest-absent ({@link ABSENT_ROUNDS_SOURCE}: no dispatchable round, an empty ledger, no
// report) so a subtree mounted without a rounds scope says so rather than pretending. Tests
// and dev hand a fixture {@link RoundsSource} to {@link RoundsSourceProvider}; the fixtures
// live behind the import fence (`test/fixtures/rounds/`), never imported by a surface.
// ─────────────────────────────────────────────────────────────────────────────

/** A shared frozen empty ledger — a STABLE reference, so the honest-absent source does
 *  not hand back a fresh array per render (the Zustand/re-render trap C09 warns of). */
const NO_RECORDS: readonly RoundLedgerRecord[] = Object.freeze([]);

/** The same stable-reference discipline for an empty progress log. */
const NO_EVENTS: readonly RoundEvent[] = Object.freeze([]);

/**
 * The three reads (plus dispatch) every rounds surface resolves through. `reportBoard`
 * returns `unknown` on purpose: the seam OWNS validation, so a source hands back
 * whatever it has and {@link useReportBoard} is the one place report shape is proven.
 * `dispatch` is present on the LIVE source (unconditionally — {@link useLiveRoundsSource})
 * and absent on the honest-absent default, so the Dispatch button is live wherever the app
 * tree is mounted and inert only in a tree carrying no rounds scope.
 */
export interface RoundsSource {
  /** The live round machine state for a session (honest-absent by default). */
  readonly roundState: (slug: string) => RoundState;
  /** The session's completed rounds, oldest→newest (empty when none). */
  readonly roundRecords: (slug: string) => readonly RoundLedgerRecord[];
  /** Raw report-board data by id, or `undefined` when the id resolves nothing. */
  readonly reportBoard: (reportBoardId: string) => unknown;
  /** Dispatch a work-order round for `slug`; absent ⇒ no live runtime, button disabled. */
  readonly dispatch?: (slug: string) => Promise<RoundDispatchOutcome>;
  /** Retry this session's retained failed operation from its durable checkpoint. */
  readonly retry?: (slug: string) => void;
  /** True while a retry request for this session is awaiting its durable acceptance. */
  readonly retryPending?: (slug: string) => boolean;
  /** The daemon's rejection of the latest retry request, when one exists. */
  readonly retryError?: (slug: string) => string | undefined;
  /**
   * True while this session's round state has been ASKED for and not yet answered — the
   * honest "not known yet", which is NOT the same fact as `absent`'s "there is no round".
   * A surface that would navigate off an absent round (the run route's fallback) waits for
   * this to clear, so a cold mid-round deep-link is not bounced to the board a frame before
   * its catch-up read lands. Omitted by sources that always know (the fixtures, and the
   * honest-absent default) ⇒ never pending.
   */
  readonly roundPending?: (slug: string) => boolean;
  /**
   * True while this session's rounds LEDGER read is in flight — the honest "not known yet",
   * which is NOT `roundRecords`' empty "there are no rounds" (#571). Distinct from
   * {@link roundPending}, which is keyed on the live-progress read: a surface asking whether
   * the LEDGER has arrived must not read the round-events read's flight. Omitted by sources
   * that always know (the fixtures, the honest-absent default) ⇒ never pending.
   */
  readonly roundRecordsPending?: (slug: string) => boolean;
  /**
   * Why this session's rounds LEDGER cannot be read, in the daemon's own words — or
   * `undefined` when it can (review finding 9). A client can outrun the daemon it is
   * talking to: an older daemon does not answer the rounds reads at all, and the
   * answer-shaped absence ("no rounds have completed") is then a lie about a fact nobody
   * established. It is the LEDGER read alone: a failure elsewhere must not hide records
   * that came back perfectly well.
   *
   * This is a STATEMENT, not a gate: the surfaces render the reason where the rounds would
   * have been and carry on. There is no capability negotiation, no version handshake and
   * nothing to dismiss — the daemon's own rejection is the disclosure.
   */
  readonly roundsUnavailable?: (slug: string) => string | undefined;
}

/** The complete answer to one client dispatch request. Only `accepted` owns navigation. */
export type RoundDispatchOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "not-dispatched"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string };

/** The honest-absent default: no live round, an empty ledger, no report, no dispatch. The
 *  CONTEXT default only — the app tree binds {@link useLiveRoundsSource} through
 *  `routes/app.tsx`'s `LiveRoundsScope`, so a surface that reaches THIS value is one mounted
 *  outside that scope (a unit mount), and it renders its round exits inert accordingly. */
export const ABSENT_ROUNDS_SOURCE: RoundsSource = {
  roundState: () => initialRoundState,
  roundRecords: () => NO_RECORDS,
  reportBoard: () => undefined,
};

const RoundsSourceContext = createContext<RoundsSource>(ABSENT_ROUNDS_SOURCE);

/** Supplies the rounds source (fixtures today; swapped to the live runtime at cluster 8). */
export const RoundsSourceProvider = RoundsSourceContext.Provider;

/**
 * The resolution of a report-board request. A report is joined into the rounds ledger by
 * its durable board id. `valid`: shape passed `RoundReportBoardSchema`. `missing`: the
 * source has no board for this id. `invalid`: the
 * source answered with something the schema rejected — an honest error, never "no round".
 */
export type ReportBoardResolution =
  | { readonly status: "valid"; readonly board: RoundReportBoard }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly detail: unknown };

/**
 * Parse raw report-board data against `RoundReportBoardSchema` — the pure core of the report read,
 * validated at the RUNTIME boundary (finding 4). The client never trusts report shape it did
 * not validate: a shape failure resolves `invalid` (rendered distinctly), separate from
 * `missing`. One further runtime check past the schema binds the response to the requested id:
 *
 *   - IDENTITY: the resolved board's `boardId` must equal the `expectedId` requested. A source
 *     that answers the wrong board (a cross-wire) is `invalid`, not silently rendered AS the
 *     selected report. (Unlike a lens board, a report is fetched by id, so id — not
 *     `(generation, lens)` — is the identity to check.)
 */
export function resolveReportBoard(raw: unknown, expectedId: string): ReportBoardResolution {
  if (raw === undefined) return { status: "missing" };
  const parsed = RoundReportBoardSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", detail: parsed.error };
  const board = parsed.data;
  if (board.boardId !== expectedId) {
    return {
      status: "invalid",
      detail: `report id mismatch: expected ${expectedId}, got ${board.boardId}`,
    };
  }
  return { status: "valid", board };
}

/** The live round machine state for a session — honest-absent by default. */
export function useRoundState(slug: string): RoundState {
  return useContext(RoundsSourceContext).roundState(slug);
}

/** True while the source is still fetching this session's round state — see
 *  {@link RoundsSource.roundPending}. False for any source that always knows. */
export function useRoundPending(slug: string): boolean {
  return useContext(RoundsSourceContext).roundPending?.(slug) ?? false;
}

/** Why this session's rounds cannot be read (an older daemon that does not answer the
 *  rounds reads), or `undefined` when they can — see {@link RoundsSource.roundsUnavailable}. */
export function useRoundsUnavailable(slug: string): string | undefined {
  return useContext(RoundsSourceContext).roundsUnavailable?.(slug);
}

/** The session's completed rounds, oldest→newest — empty (stable ref) by default. */
export function useRoundRecords(slug: string): readonly RoundLedgerRecord[] {
  return useContext(RoundsSourceContext).roundRecords(slug);
}

/** True while the LEDGER read is still in flight — see {@link RoundsSource.roundRecordsPending}.
 *  The three situations `useRoundRecords` returns `[]` for are "no rounds", "not back yet",
 *  and "could not be read"; this separates the second, `useRoundsUnavailable` the third. */
export function useRoundRecordsPending(slug: string): boolean {
  return useContext(RoundsSourceContext).roundRecordsPending?.(slug) ?? false;
}

/** Resolve a report board by id, validated against its report-specific schema and identity. */
export function useReportBoard(reportBoardId: string): ReportBoardResolution {
  return resolveReportBoard(
    useContext(RoundsSourceContext).reportBoard(reportBoardId),
    reportBoardId,
  );
}

/** The dispatch capability for the current source — present under the app tree's
 *  `LiveRoundsScope`, `undefined` under the honest-absent default (⇒ the Dispatch button
 *  stays inert). `HandoffMount` reads this and threads it to the handoff lanes. */
export function useRoundDispatch():
  | ((slug: string) => Promise<RoundDispatchOutcome>)
  | undefined {
  return useContext(RoundsSourceContext).dispatch;
}

export function useRoundRetry(): ((slug: string) => void) | undefined {
  return useContext(RoundsSourceContext).retry;
}

export function useRoundRetryPending(slug: string): boolean {
  return useContext(RoundsSourceContext).retryPending?.(slug) ?? false;
}

export function useRoundRetryError(slug: string): string | undefined {
  return useContext(RoundsSourceContext).retryError?.(slug);
}

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE seam body (C15 3.2) — the swap C09 cluster 8 left a home for. The callers do
// not change; only the source does. The three reads resolve against the daemon:
//
//   • `roundState` — the `session.roundEvents` catch-up read with the `roundProgress`
//     push channel folded into the SAME cache entry (`useCommandStream`), then reduced
//     through `advance`. The rows advance on REAL events — the fixture clock is gone
//     from the app tree (the fixtures stay, for tests).
//   • `roundRecords` — the `session.rounds` ledger read, including exact report projections.
//   • `reportBoard` — the report embedded on the exact ledger record naming that board id.
//   • `dispatch` — the `round.dispatch` write, so the round exit actually kicks a round.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reviewer's dispatch INTENT — what the client asked for, held apart from what the
 * daemon has confirmed. `sending` is honest optimism ("we asked, nothing has come back");
 * `rejected` is the receipt refusing it, carrying the daemon's own words. There is no
 * "dispatched" arm: that is the DAEMON's fact, and it arrives as a `RoundEvent`.
 */
type DispatchIntent =
  | { readonly slug: string; readonly status: "sending" }
  | { readonly slug: string; readonly status: "rejected"; readonly reason: string };

/** A rejection in readable words — the daemon's message where it gave one. */
function failureText(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return typeof reason === "string" && reason.length > 0 ? reason : "the daemon refused the call";
}

/** A read's error as a disclosure string, or `undefined` when the read is fine. */
function readFailure(error: unknown): string | undefined {
  return error === undefined || error === null ? undefined : failureText(error);
}

/** A round-progress receipt emitted only after a transcript append it makes visible.
 * Dispatch is appended before `claimed`; a completed or failed worker capture before
 * `worker-settled`/worker failure; Return before the terminal `composed`/`unchanged` receipt. */
function transcriptRefreshReceipt(event: RoundEvent): boolean {
  if (event.type === "composed" || event.type === "unchanged") return true;
  if (event.type !== "operation") return false;
  const state = event.snapshot.state;
  return (
    state.phase === "claimed" ||
    state.phase === "worker-settled" ||
    (state.phase === "failed" && state.failure.at === "worker")
  );
}

/** The durable session slug the current route is on, or `undefined` off a session route. */
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
  const resolution = useSlugResolution(slug ?? "");
  const reviewId = reviewIdOf(resolution);
  const resolvingReview = resolution.status === "pending";
  const enabled = reviewId !== undefined;
  const eventsCommand = {
    name: "session.roundEvents" as const,
    input: { reviewId: reviewId ?? "" },
  };

  const { cache } = useBridgeContext();
  const { data: eventsData, pending: eventsPending } = useCommand(
    eventsCommand.name,
    eventsCommand.input,
    { enabled },
  );

  // The live push. It folds into the read's own cache entry (so one entry re-renders every
  // reader) AND into `streamed`, which the read's response CANNOT overwrite: the entry is
  // reinstalled wholesale whenever the catch-up read settles or a mutation invalidates it,
  // so an event that landed during that flight would otherwise be gone. The two are merged
  // by `seq` at read time — see {@link mergeRoundEvents}.
  const streamed = useRef<readonly RoundEvent[]>(NO_EVENTS);
  const streamKey = useRef(reviewId);
  if (streamKey.current !== reviewId) {
    streamKey.current = reviewId;
    streamed.current = NO_EVENTS;
  }
  useCommandStream({
    channel: "roundProgress",
    delivery: "delta",
    subscriptionKey: reviewId,
    command: eventsCommand,
    fold: (prev, event) => {
      streamed.current = mergeRoundEvents(streamed.current, [event]);
      // A changed or failed durable terminal snapshot follows every ledger write it can
      // expose. An unchanged snapshot does not: finalizeUnchanged writes afterward and
      // emits the legacy unchanged receipt as its post-write commit point.
      const durableTerminal =
        event.type === "operation" &&
        (event.snapshot.state.phase === "failed" ||
          (event.snapshot.state.phase === "completed" &&
            event.snapshot.draining !== true &&
            event.snapshot.state.result.kind === "changed"));
      if (
        durableTerminal ||
        event.type === "composed" ||
        event.type === "unchanged" ||
        event.type === "failed"
      ) {
        cache.invalidate(commandKey("session.rounds", { reviewId: reviewId ?? "" }));
        cache.invalidate(commandKey("session.list", {}));
      }
      if (transcriptRefreshReceipt(event)) {
        cache.invalidate(commandKey("session.transcript", { reviewId: reviewId ?? "" }));
      }
      return { events: [...mergeRoundEvents(prev?.events ?? NO_EVENTS, [event])] };
    },
  });

  const {
    data: recordsData,
    error: recordsError,
    pending: recordsPending,
  } = useCommand("session.rounds", { reviewId: reviewId ?? "" }, { enabled });
  const { mutate } = useMutation("round.dispatch");
  const { mutate: retry, pending: retryPending, error: retryError } = useMutation("round.retry");

  // The reviewer's dispatch INTENT, held here and never written into the event log (review
  // finding 7). The old code folded a `{type:"dispatched"}` of its own making into the log
  // and then swallowed the rejection, so a dispatch the daemon REFUSED still read as a
  // round under way — the client stating a server fact it had not been told. The intent
  // says only what is true ("we asked, and are waiting"); the daemon's receipt is what
  // promotes it into a real round, and its rejection is what surfaces honestly instead.
  const [intent, setIntent] = useState<DispatchIntent | undefined>(undefined);

  const events = eventsData?.events;
  const records = recordsData?.records;
  // Keyed on the LEDGER read alone. Folding the live-progress read's failure in here hid
  // a ledger we actually hold behind "Rennet cannot read this session's rounds" — the same
  // dishonesty in the other direction, since the records had come back fine.
  const unavailable = readFailure(recordsError);
  return useMemo(() => {
    // The machine IS the fold: the same reducer the daemon's events were designed for, over
    // the merged union of the catch-up read and the live push. No wall clock anywhere.
    const merged = mergeRoundEvents(events ?? NO_EVENTS, streamed.current);
    const folded = merged.reduce(advance, initialRoundState);
    const stateFor = (forSlug: string): RoundState => {
      if (forSlug !== slug) return initialRoundState;
      // The daemon's own account always wins: the intent covers exactly the window in
      // which the daemon has said nothing, and stops speaking the moment it does.
      if (merged.length > 0 || intent?.slug !== forSlug) return folded;
      return intent.status === "rejected"
        ? // The receipt refused the round. It never started, and saying so is the honest
          // end of the intent — not a silent bounce back to the board.
          { phase: "failed", reason: intent.reason }
        : // Asked, and nothing back yet. The client's own intent, stated as such.
          { phase: "dispatching" };
    };
    return {
      roundState: stateFor,
      roundRecords: (forSlug: string) => (forSlug === slug ? (records ?? NO_RECORDS) : NO_RECORDS),
      roundPending: (forSlug: string) => forSlug === slug && (resolvingReview || eventsPending),
      // The LEDGER read's own flight (#571) — keyed on `session.rounds`, not the round-events
      // read above. A cold deep-link to a round diff waits on THIS.
      roundRecordsPending: (forSlug: string) =>
        forSlug === slug && (resolvingReview || recordsPending),
      roundsUnavailable: (forSlug: string) => (forSlug === slug ? unavailable : undefined),
      reportBoard: (reportBoardId: string) =>
        records?.findLast((record) => record.reportBoard === reportBoardId)?.report,
      retry: (forSlug: string) => {
        if (forSlug !== slug || reviewId === undefined) return;
        void retry({ reviewId })
          .then((output) => {
            const accepted: RoundEvent = {
              type: "operation",
              snapshot: output.acceptedOperation,
            };
            streamed.current = mergeRoundEvents(streamed.current, [accepted]);
            cache.setData(
              commandKey("session.roundEvents", { reviewId }),
              () => ({ events: [...streamed.current] }),
              { supersedeInFlight: true },
            );
            cache.invalidate(commandKey("session.roundEvents", { reviewId }));
          })
          .catch(() => undefined);
      },
      retryPending: (forSlug: string) => forSlug === slug && retryPending,
      retryError: (forSlug: string) =>
        forSlug === slug && retryError !== undefined ? failureText(retryError) : undefined,
      dispatch: async (forSlug: string): Promise<RoundDispatchOutcome> => {
        if (reviewId === undefined) {
          return { status: "rejected", reason: "Rennet could not resolve this review." };
        }
        const previousEvents = merged;
        // A new round starts from nothing: drop the finished round's events rather than
        // fold this one onto its `composed` state. That is DISCARDING stale data, not
        // asserting a new fact — the log refills from the daemon's own `dispatched`.
        streamed.current = NO_EVENTS;
        cache.setData(
          commandKey("session.roundEvents", { reviewId }),
          () => ({ events: [] satisfies RoundEvent[] }),
          { supersedeInFlight: true },
        );
        setIntent({ slug: forSlug, status: "sending" });
        try {
          const output = await mutate({ reviewId });
          if (!output.dispatched) {
            const reason =
              "Rennet did not start a coding round. Questions and approvals remain staged for the review.";
            cache.setData(
              commandKey("session.roundEvents", { reviewId }),
              () => ({ events: [...previousEvents] }),
              { supersedeInFlight: true },
            );
            setIntent(undefined);
            return { status: "not-dispatched", reason };
          }
          if (output.acceptedOperation !== undefined) {
            const accepted: RoundEvent = {
              type: "operation",
              snapshot: output.acceptedOperation,
            };
            streamed.current = mergeRoundEvents(streamed.current, [accepted]);
            cache.setData(
              commandKey("session.roundEvents", { reviewId }),
              () => ({ events: [...streamed.current] }),
              { supersedeInFlight: true },
            );
          }
          cache.invalidate(commandKey("session.roundEvents", { reviewId }));
          return { status: "accepted" };
        } catch (reason: unknown) {
          const message = failureText(reason);
          setIntent({ slug: forSlug, status: "rejected", reason: message });
          return { status: "rejected", reason: message };
        }
      },
    };
  }, [
    events,
    records,
    slug,
    reviewId,
    mutate,
    retry,
    retryPending,
    retryError,
    cache,
    eventsPending,
    recordsPending,
    resolvingReview,
    unavailable,
    intent,
  ]);
}
