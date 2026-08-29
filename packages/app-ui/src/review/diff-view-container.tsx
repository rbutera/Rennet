import type { Review, RoundRecord } from "@rennet/protocol";
import { activePatchsetFiles } from "./diff-source";
import { DiffView } from "./diff-view";

// ─────────────────────────────────────────────────────────────────────────────
// The diff mount (C6, task 4.2). Reads the active patchset's changed files off the
// resolved review through the ONE projection seam (`diff-source.ts`) and renders the
// surface. An empty or absent patchset gets an honest one-line state — never a blank
// frame. The flex-column wrapper gives the surface (`flex flex-1`) its height inside the
// outlet's block cell.
//
// Round diff (#571): the rounds ledger links here with `?round=<round number>` to read a PAST
// round's diff — the checkpoint-measured diff of that round's coding turn, which the round
// record has carried all along (`RoundRecord.diff`, split per file at the `session.rounds`
// read). It is the round's OWN change, not the review's whole changeset, and it is immutable:
// the durable ledger preserves it across the regeneration that supersedes the dispatch
// placeholder, so a later round never rewrites an earlier round's diff.
//
// The round is addressed by its LEDGER NUMBER, not its generation id: a dispatch round that
// regenerated nothing carries `ROUND_NO_REGEN`, so generation ids do not name rounds back.
//
// An empty `records` is THREE different facts — the session has no rounds, the ledger read has
// not come back, and the ledger read FAILED — and only the first is an absence. A cold
// deep-link (the bookmark this ordinal address exists to serve) arrives with the read in
// flight, and a daemon that cannot answer `session.rounds` never answers it at all; saying
// "that round is not in the ledger" in either case blames the round for the read. So the
// container takes `pending` and `unavailable` as their own facts and states them.
//
// The round surface is `historical`: its line numbers are the round's, not the review's, so
// `DiffView` carries no gutter and no selection toolbar there — see `DiffViewProps.historical`
// for what writing under those coordinates would silently do.
// ─────────────────────────────────────────────────────────────────────────────

/** One-line honest state, the shape every empty diff branch uses. */
function DiffNotice({ children, testId }: { children: string; testId?: string }) {
  return (
    <div
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className="flex h-full items-center justify-center p-10 text-center font-serif text-ink-soft"
      role="status"
    >
      {children}
    </div>
  );
}

export function DiffViewContainer({
  review,
  records = [],
  recordsPending = false,
  recordsUnavailable,
  round,
}: {
  review: Review;
  /** The session's completed rounds, oldest→newest — what `?round=` indexes into. */
  readonly records?: readonly RoundRecord[];
  /** True while the ledger read is still in flight — `records` is empty because nothing has
   *  come back yet, which is not the fact "this session has no rounds". */
  readonly recordsPending?: boolean;
  /** Why the ledger could not be read, in the daemon's own words, or undefined when it could.
   *  Present ⇒ `records` is empty because nobody could tell us. */
  readonly recordsUnavailable?: string;
  /** A past round's 1-based ledger number (the ledger's Round-diff link), or undefined for
   *  the live review diff. */
  round?: string;
}) {
  if (round !== undefined) {
    if (recordsUnavailable !== undefined) {
      return (
        <DiffNotice testId="round-diff-unavailable">
          {`Rennet could not read this session's rounds, so it cannot open this one: ${recordsUnavailable}`}
        </DiffNotice>
      );
    }
    if (recordsPending) {
      return <DiffNotice testId="round-diff-loading">Reading this session's rounds…</DiffNotice>;
    }
    const number = Number(round);
    const record = Number.isInteger(number) && number >= 1 ? records[number - 1] : undefined;
    if (record === undefined) {
      return (
        <DiffNotice testId="round-diff-unknown">
          This link names a round that is not in this session's ledger.
        </DiffNotice>
      );
    }
    const files = record.diffFiles ?? [];
    if (files.length === 0) {
      // Three ways reach here — a round that regenerated without running a work order, a work
      // order that changed nothing, and a diff that parsed to no files — and this branch
      // cannot tell them apart. It states what it knows and stops: naming a cause it has not
      // established is the same defect as the notice it replaced.
      return (
        <DiffNotice testId="round-diff-uncaptured">
          This round has no diff of its own to show.
        </DiffNotice>
      );
    }
    return (
      <div
        data-testid="round-diff"
        data-round={String(number)}
        className="flex h-full min-h-0 flex-col"
      >
        <DiffView files={files} historical />
      </div>
    );
  }
  const files = activePatchsetFiles(review);
  if (files.length === 0) {
    return <DiffNotice>This patchset has no changed files to show.</DiffNotice>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiffView files={files} patchsetId={review.activePatchsetId} />
    </div>
  );
}
