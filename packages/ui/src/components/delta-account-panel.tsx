import type {
  AnchorSide,
  AnchorSpan,
  DeltaAccount,
  DeltaAskStatus,
  DeltaBeyondHunk,
} from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The DELTA RE-REVIEW ACCOUNT (issue #73). Rendered at the TOP of a successor
// review — the entry to delta re-review (journey stage 7) — it states, before the
// reviewer re-reads a line, what the returned patchset did:
//   • "What moved" — each staged ask as addressed / partially addressed / untouched,
//     naming the composed task that ran it when the successor came from a handoff run.
//   • "Beyond your asks" — every path the successor changed that NO ask targeted,
//     surfaced LOUDLY (the scope-creep the reviewer must see), plus — at HUNK grain
//     (#73 wave 3) — the exact changes beyond the asks, INCLUDING a hunk inside an
//     asked file that path grain cannot see.
//
// Every fact here is the DETERMINISTIC account (`buildDeltaAccount`, model-free); this
// component only renders it. It is INFORMATIONAL — it gates nothing (Rule Zero): the
// reviewer reads on and signs without dismissing it. Each item ANCHORS: activating it
// navigates the diff to that path (`onAnchor`), or to a hunk's exact span when known.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<DeltaAskStatus, string> = {
  addressed: "Addressed",
  "partially-addressed": "Partially addressed",
  untouched: "Untouched",
};

const BUCKET_LABEL: Record<DeltaBeyondHunk["bucket"], string> = {
  "unasked-file": "in a file no ask targeted",
  "asked-file": "inside an asked file, beyond the asked lines",
};

/** "line 5" or "lines 40–42" from a hunk's file-line span. */
function formatSpan(span: AnchorSpan): string {
  const { startLine, endLine } = span;
  return endLine !== undefined && endLine !== startLine
    ? `lines ${startLine}–${endLine}`
    : `line ${startLine}`;
}

export function DeltaAccountPanel({
  account,
  onAnchor,
  digest,
}: {
  account: DeltaAccount;
  /**
   * Navigate the diff to `path` — or, when a `span`/`side` is given (a hunk-grain
   * beyond-ask row, #73 wave 3), to that exact file line range. Ask rows without a span
   * still call with `path` alone (path-grain navigation, unchanged).
   */
  onAnchor: (path: string, span?: AnchorSpan, side?: AnchorSide) => void;
  /**
   * The optional light-tier LLM digest (issue #73 / M25): a one/two-sentence TL;DR of
   * the account below, shown ON TOP of the facts as the one-glance read. Absent ⇒ no
   * headline and the facts are unchanged — the model-free floor (the facts are the
   * authoritative ground truth and render with or without it). It adds no fact the
   * facts don't carry, and gates nothing.
   */
  digest?: string;
}) {
  const hasAsks = account.asks.length > 0;
  const hasBeyond = account.beyondAsks.length > 0;
  const hunks = account.beyondAskHunks ?? [];
  const hasHunks = hunks.length > 0;
  if (!hasAsks && !hasBeyond && !hasHunks) return null;

  return (
    <section
      className="delta-account"
      data-testid="delta-account"
      aria-label="Delta re-review account"
    >
      <p className="delta-account-eyebrow">Since you last reviewed</p>

      {digest ? (
        <div className="delta-account-digest" data-testid="delta-account-digest">
          <p className="delta-account-digest-lead">{digest}</p>
          <p className="delta-account-digest-tag">written from the facts below · light model</p>
        </div>
      ) : null}

      {hasAsks ? (
        <ul className="delta-account-asks">
          {account.asks.map((ask) => (
            <li
              key={`${ask.path}:${ask.side ?? ""}:${ask.span?.startLine ?? ""}:${ask.span?.endLine ?? ""}`}
              className="delta-account-ask"
              data-status={ask.status}
            >
              <button
                type="button"
                className="delta-account-item"
                onClick={() =>
                  ask.span ? onAnchor(ask.path, ask.span, ask.side) : onAnchor(ask.path)
                }
              >
                <span className="delta-account-status" data-status={ask.status}>
                  {STATUS_LABEL[ask.status]}
                </span>
                <code className="delta-account-path">{ask.path}</code>
                {ask.summary ? <span className="delta-account-summary">{ask.summary}</span> : null}
                {/* The composed task that ran this ask on a handoff run (#73 wave 3) —
                    narration only, 1-based for the human ("task 2 — 'Tighten the parser'"). */}
                {ask.handoffTask ? (
                  <span className="delta-account-task" data-testid="delta-account-task">
                    task {ask.handoffTask.index + 1} — “{ask.handoffTask.title}”
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {hasBeyond ? (
        <div className="delta-account-beyond" data-testid="delta-account-beyond" role="alert">
          <p className="delta-account-beyond-title">
            {account.beyondAsks.length} change{account.beyondAsks.length === 1 ? "" : "s"} beyond
            your asks
          </p>
          <ul className="delta-account-beyond-list">
            {account.beyondAsks.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="delta-account-item delta-account-beyond-item"
                  onClick={() => onAnchor(path)}
                >
                  <code className="delta-account-path">{path}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Hunk-grain detail (#73 wave 3): the exact changes beyond the asks, each anchoring
          to its span. NARRATION, not a second alarm — the loud path alert above owns the
          scope-creep signal; this refines it to line ranges and surfaces the asked-file
          case (a change inside a file you asked about, outside the asked lines) that path
          grain cannot show. Never a violation, never a gate (Rule Zero). */}
      {hasHunks ? (
        <ul className="delta-account-hunks" data-testid="delta-account-hunks">
          {hunks.map((hunk) => (
            <li
              key={`${hunk.path}:${hunk.side ?? ""}:${hunk.span.startLine}:${hunk.span.endLine ?? ""}`}
              className="delta-account-hunk-row"
            >
              <button
                type="button"
                className="delta-account-item delta-account-hunk-item"
                data-testid="delta-account-hunk"
                data-bucket={hunk.bucket}
                onClick={() => onAnchor(hunk.path, hunk.span, hunk.side)}
              >
                <code className="delta-account-path">{hunk.path}</code>
                <span className="delta-account-hunk-span">{formatSpan(hunk.span)}</span>
                <span className="delta-account-hunk-bucket">{BUCKET_LABEL[hunk.bucket]}</span>
                {hunk.excerpt ? (
                  <code className="delta-account-hunk-excerpt">{hunk.excerpt}</code>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
