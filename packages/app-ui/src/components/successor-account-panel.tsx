import type {
  AnchorSide,
  AnchorSpan,
  DeltaAskStatus,
  DeltaBeyondHunk,
  SuccessorAccount,
} from "@rennet/protocol";

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
// Every fact here is the DETERMINISTIC account (`buildSuccessorAccount`, model-free); this
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

export function SuccessorAccountPanel({
  account,
  onAnchor,
  digest,
}: {
  account: SuccessorAccount;
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
      className="successor-account flex flex-col gap-2 border-b border-line bg-surface px-5 py-3"
      data-testid="successor-account"
      aria-label="Delta re-review account"
    >
      <p className="successor-account-eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        Since you last reviewed
      </p>

      {digest ? (
        <div
          className="successor-account-digest flex flex-col gap-1 py-0.5"
          data-testid="successor-account-digest"
        >
          <p className="successor-account-digest-lead m-0 font-serif text-base leading-relaxed text-ink">
            {digest}
          </p>
          <p className="successor-account-digest-tag m-0 text-2xs tracking-wide text-ink-faint">
            written from the facts below · light model
          </p>
        </div>
      ) : null}

      {hasAsks ? (
        <ul className="successor-account-asks m-0 flex list-none flex-col gap-0.5 p-0">
          {account.asks.map((ask) => (
            <li
              key={`${ask.path}:${ask.side ?? ""}:${ask.span?.startLine ?? ""}:${ask.span?.endLine ?? ""}`}
              className="successor-account-ask"
              data-status={ask.status}
            >
              <button
                type="button"
                className="successor-account-item flex w-full cursor-pointer items-baseline gap-2.5 rounded-chip border-0 bg-transparent px-2 py-1.5 text-left text-ink hover:bg-raised"
                onClick={() =>
                  ask.span ? onAnchor(ask.path, ask.span, ask.side) : onAnchor(ask.path)
                }
              >
                <span
                  className="successor-account-status min-w-[116px] flex-none text-2xs font-semibold data-[status=addressed]:text-green data-[status=partially-addressed]:text-accent data-[status=untouched]:text-ink-faint"
                  data-status={ask.status}
                >
                  {STATUS_LABEL[ask.status]}
                </span>
                <code className="successor-account-path flex-none font-mono text-sm text-ink-soft">
                  {ask.path}
                </code>
                {ask.summary ? (
                  <span className="successor-account-summary min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-ink-soft">
                    {ask.summary}
                  </span>
                ) : null}
                {/* The composed task that ran this ask on a handoff run (#73 wave 3) —
                    narration only, 1-based for the human ("task 2 — 'Tighten the parser'"). */}
                {ask.handoffTask ? (
                  <span
                    className="successor-account-task flex-none text-2xs text-ink-faint"
                    data-testid="successor-account-task"
                  >
                    task {ask.handoffTask.index + 1} — “{ask.handoffTask.title}”
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {hasBeyond ? (
        <div
          className="successor-account-beyond flex flex-col gap-1 rounded-control border border-accent-line bg-accent-surface px-2.5 py-2"
          data-testid="successor-account-beyond"
          role="alert"
        >
          <p className="successor-account-beyond-title m-0 text-sm font-semibold text-ink">
            {account.beyondAsks.length} change{account.beyondAsks.length === 1 ? "" : "s"} beyond
            your asks
          </p>
          <ul className="successor-account-beyond-list m-0 flex list-none flex-col gap-0.5 p-0">
            {account.beyondAsks.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="successor-account-item successor-account-beyond-item flex w-full cursor-pointer items-baseline gap-2.5 rounded-chip border-0 bg-transparent px-1.5 py-0.5 text-left text-ink hover:bg-raised"
                  onClick={() => onAnchor(path)}
                >
                  <code className="successor-account-path flex-none font-mono text-sm text-ink-soft">
                    {path}
                  </code>
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
        <ul
          className="successor-account-hunks m-0 flex list-none flex-col gap-0.5 p-0"
          data-testid="successor-account-hunks"
        >
          {hunks.map((hunk) => (
            <li
              key={`${hunk.path}:${hunk.side ?? ""}:${hunk.span.startLine}:${hunk.span.endLine ?? ""}`}
              className="successor-account-hunk-row"
            >
              <button
                type="button"
                className="successor-account-item successor-account-hunk-item group flex w-full cursor-pointer items-baseline gap-2 rounded-chip border-0 bg-transparent px-1.5 py-0.5 text-left text-ink hover:bg-raised"
                data-testid="successor-account-hunk"
                data-bucket={hunk.bucket}
                onClick={() => onAnchor(hunk.path, hunk.span, hunk.side)}
              >
                <code className="successor-account-path flex-none font-mono text-sm text-ink-soft">
                  {hunk.path}
                </code>
                <span className="successor-account-hunk-span flex-none text-2xs text-ink-soft">
                  {formatSpan(hunk.span)}
                </span>
                <span className="successor-account-hunk-bucket flex-none text-2xs text-ink-faint group-data-[bucket=unasked-file]:text-ink">
                  {BUCKET_LABEL[hunk.bucket]}
                </span>
                {hunk.excerpt ? (
                  <code className="successor-account-hunk-excerpt min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-2xs text-ink-faint">
                    {hunk.excerpt}
                  </code>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
