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
// The ledger offers the control ONLY for a round that captured a diff (absent, not disabled),
// so both branches below are reachable only from a stale or hand-written link — and they say
// which of the two it is rather than blaming the wrong absence.
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
  round,
}: {
  review: Review;
  /** The session's completed rounds, oldest→newest — what `?round=` indexes into. */
  readonly records?: readonly RoundRecord[];
  /** A past round's 1-based ledger number (the ledger's Round-diff link), or undefined for
   *  the live review diff. */
  round?: string;
}) {
  if (round !== undefined) {
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
      return (
        <DiffNotice testId="round-diff-uncaptured">
          This round captured no diff of its own — it regenerated the boards without running a work
          order.
        </DiffNotice>
      );
    }
    return (
      <div
        data-testid="round-diff"
        data-round={String(number)}
        className="flex h-full min-h-0 flex-col"
      >
        <DiffView files={files} />
      </div>
    );
  }
  const files = activePatchsetFiles(review);
  if (files.length === 0) {
    return <DiffNotice>This patchset has no changed files to show.</DiffNotice>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiffView files={files} />
    </div>
  );
}
