import { Button, cn } from "@rennet/ui";
import { Check, Loader2, Minus } from "lucide-react";
import { useEffect } from "react";
import { Redirect, useLocation } from "wouter";
import { sessionPath } from "../routes/url";
import { useRennetStore } from "../store";
import {
  type LaneRow,
  type RoundState,
  type RowStatus,
  roundTargetLabel,
  runNavigation,
} from "./round-machine";
import {
  useRoundPending,
  useRoundRetry,
  useRoundRetryError,
  useRoundRetryPending,
  useRoundState,
} from "./rounds-data";

// ─────────────────────────────────────────────────────────────────────────────
// The run route (C09 §3) — the live work-order round watched at `/s/:slug/run`. The
// spike's `run-view.tsx` drove the whole thing off a `setInterval` clock and navigated
// from an effect that raced itself (autopsy S9). Here the route is a pure read of the
// machine: `useRoundState` folds real progress (the live source's `useCommandStream`
// over `session.roundEvents` + the push channel; a fixture source in tests), the phase
// carries the rows to render, and navigation is DERIVED from
// `runNavigation(state, slug)` — a `<Redirect>` off the current state, never an effect
// that reads the state its own navigate mutates. There is NO `setTimeout` in this path.
//
// Cold deep-link: mounting only READS `useRoundState` (the seam reattaches the progress
// subscription); the route NEVER dispatches — dispatch is cluster 4's explicit act — so
// a cold mid-round mount reattaches without a double-dispatch (the guard cluster 3.4
// proves with a zero `dispatchCount`).
// ─────────────────────────────────────────────────────────────────────────────

/** A stable empty row list — phases without prep/worker rows resolve to the same ref. */
const NO_ROWS: readonly LaneRow[] = Object.freeze([]);

/** The status glyph for a live row — queued ring, running spinner, done check, absent
 *  dash, failed dot.
 *  Shared with the greeting's regeneration lanes (finding 5) so a queued/failed drafter reads
 *  the same everywhere, never a false green check. */
export function StatusIcon({ status }: { readonly status: RowStatus }) {
  if (status === "running")
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-model" aria-hidden="true" />;
  if (status === "queued")
    return (
      <span className="size-3.5 shrink-0 rounded-full border border-border" aria-hidden="true" />
    );
  if (status === "failed")
    return <span className="size-3.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />;
  if (status === "absent")
    return <Minus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
  // `drafted` and `done` are both "this one is finished" — a lens lane's verdict is the
  // thing that differs, and it renders beside the glyph, not as a second glyph.
  return <Check className="size-3.5 shrink-0 text-green-500" aria-hidden="true" />;
}

/** A flat prep/tail line (the spike's `StepLine`), driven by the row's status, not a clock. */
function StepLine({ row }: { readonly row: LaneRow }) {
  const running = row.status === "running";
  // The row's own account of itself, read off the arm that HAS one: a settled step's
  // detail, a failed step's reason. The unstarted arms carry neither, by construction.
  const note = stepNote(row);
  return (
    <div className="flex items-center gap-1.5 text-xs" data-row={row.id}>
      <StatusIcon status={row.status} />
      <span className={cn("truncate", running ? "text-foreground" : "text-muted-foreground")}>
        {row.label}
        {note ? ` · ${note}` : ""}
      </span>
    </div>
  );
}

/** A step row's own words — `detail` when it settled, `reason` when it failed, else none. */
function stepNote(row: LaneRow): string | undefined {
  if (row.status === "done") return row.detail;
  if (row.status === "failed") return row.reason;
  return undefined;
}

/** The bordered worker/lens lane list (the spike's card list), each row a machine row. */
function LaneList({ title, rows }: { readonly title: string; readonly rows: readonly LaneRow[] }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </span>
      <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2.5 px-3.5 py-2.5" data-row={row.id}>
            <StatusIcon status={row.status} />
            <span
              className={cn(
                "text-sm font-medium",
                row.status === "queued" ? "text-muted-foreground/50" : "text-foreground",
              )}
            >
              {row.label}
            </span>
            <span className="ml-auto text-2xs text-muted-foreground">
              {row.status === "queued"
                ? "queued"
                : row.status === "running"
                  ? "running"
                  : (stepNote(row) ?? "done")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FailureActions({ slug }: { readonly slug: string }) {
  const [, navigate] = useLocation();
  const retry = useRoundRetry();
  const pending = useRoundRetryPending(slug);
  const error = useRoundRetryError(slug);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={() => navigate(sessionPath(slug))}>
          Return to Review
        </Button>
        <Button disabled={retry === undefined || pending} onClick={() => retry?.(slug)}>
          {pending ? "Retrying" : "Retry"}
        </Button>
      </div>
      {error !== undefined && (
        <p role="alert" className="max-w-[520px] text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The live in-flight run body — prep lines, the worker lane list, and the gate/commit
 *  tail, all from durable receipts. Legacy events can still render their prep and worker
 *  rows, but never gain client-authored gate, commit, or report success claims. */
function LiveRun({ state, slug }: { readonly state: RoundState; readonly slug: string }) {
  if (state.phase === "failed" && !("operation" in state)) {
    return (
      <section
        data-screen="session-run"
        data-phase="failed"
        role="alert"
        className="grid min-h-screen place-content-center justify-items-center gap-2 p-8 text-center"
      >
        <h1 className="font-display text-xl font-medium text-ink">The round failed</h1>
        <p className="max-w-[520px] text-ink-soft">{state.reason}</p>
        <FailureActions slug={slug} />
      </section>
    );
  }

  const prep = "prep" in state ? state.prep : NO_ROWS;
  const worker = "worker" in state ? state.worker : NO_ROWS;
  const tail = "tail" in state ? state.tail : NO_ROWS;
  const operation = "operation" in state ? state.operation : undefined;
  const header =
    operation === undefined
      ? "Running the round"
      : `Round ${operation.roundNumber} · ${roundTargetLabel(operation.sourceTarget)}`;

  return (
    <section
      data-screen="session-run"
      data-phase={state.phase}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-8 pt-[11vh]">
        <span className="font-display text-sm font-medium text-foreground">{header}</span>

        {prep.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {prep.map((row) => (
              <StepLine key={row.id} row={row} />
            ))}
          </div>
        )}

        {worker.length > 0 && <LaneList title="Round Worker" rows={worker} />}

        {tail.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {tail.map((row) => (
              <StepLine key={row.id} row={row} />
            ))}
          </div>
        )}

        {state.phase === "failed" && (
          <div className="flex flex-col items-center gap-3">
            <p role="alert" className="text-sm text-destructive">
              {state.reason}
            </p>
            <FailureActions slug={slug} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * `RunRoute` — the live round takeover at `/s/:slug/run`. Reads the machine state and
 * renders the in-flight run; navigation is derived off `runNavigation` (S9 fence).
 */
export function RunRoute({ slug }: { readonly slug: string }) {
  const state = useRoundState(slug);
  // The live source has ASKED for this session's round and not been answered yet. `absent`
  // and "not known yet" are different facts, and only the first means "there is no round":
  // navigating off the un-answered one bounced a cold mid-round deep-link to the board a
  // frame before its catch-up read landed, with nothing to bring the reviewer back.
  const pending = useRoundPending(slug);
  const nav = runNavigation(state, slug);
  const armGreeting = useRennetStore((s) => s.runActions.armGreeting);

  // The greeting arms only when the durable operation reports terminal completion. A
  // drafted report is still being verified and keeps ownership of the run route.
  const entersGreeting = state.phase === "composed";
  useEffect(() => {
    if (entersGreeting) armGreeting(true);
  }, [entersGreeting, armGreeting]);

  // Hold the route (render nothing, claim nothing) until the source answers.
  if (pending) return null;
  if (nav) return <Redirect to={nav.path} replace={nav.replace} />;
  return <LiveRun state={state} slug={slug} />;
}
