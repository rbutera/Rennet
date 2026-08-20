import type { HypothesisFrame, HypothesisFrameRisk } from "../canvas/hypothesis";

// The hypothesis reading frame (issue #178): the human's prior, shown BEFORE the
// lenses. It renders what this change SHOULD be (domain), what is in and out of
// scope, the design we would have chosen, and the risk list.
//
// The cross-check that pairs a predicted risk with a finding is a LEXICAL token
// overlap, not a semantic proof (packages/core/src/risk-crosscheck.ts). It can pair
// two unrelated things that share words, so a match is a WEAK pointer, never a claim
// the risk was resolved. So a matched ("confirmed") risk renders as "possibly
// related" with a jump to the finding for the reviewer to judge — it must NEVER read
// as "addressed" (a false-verdict trap). An UNMATCHED ("open") risk is the
// anti-rubber-stamp payoff — predicted, and no finding even mentioned it — so it
// carries the loud "check yourself" weight where the reviewer's attention should go.

const SEVERITY_LABEL = { high: "high", medium: "medium", low: "low" } as const;

// Severity reads by weight within the neutral scale (no dedicated hue): high inks
// full-strength on a gold-edged chip, medium and low recede. Status: an open risk
// is the anti-rubber-stamp payoff, inked full; a lexical ("confirmed") match is quiet.
const SEVERITY_CLASS = {
  high: "border-accent-line text-ink",
  medium: "border-line-strong text-ink-soft",
  low: "border-line text-ink-faint",
} as const;
const STATUS_CLASS = { open: "text-ink", confirmed: "text-ink-faint" } as const;

function RiskRow({
  risk,
  onJumpToFinding,
}: {
  risk: HypothesisFrameRisk;
  onJumpToFinding(findingId: string): void;
}) {
  return (
    <li
      className="hypothesis-risk rounded-surface border border-line bg-raised px-3 py-2.5 data-[status=open]:border-accent-line data-[status=open]:bg-accent-surface"
      data-severity={risk.severity}
      data-status={risk.status}
    >
      <div className="hypothesis-risk-head mb-1.5 flex items-center gap-2">
        <span
          className={`flag-severity flag-severity-${risk.severity} shrink-0 rounded-chip border bg-raised px-2 py-0.5 text-2xs font-bold uppercase tracking-wide ${SEVERITY_CLASS[risk.severity]}`}
        >
          {SEVERITY_LABEL[risk.severity]}
        </span>
        <span
          className={`hypothesis-status hypothesis-status-${risk.status} text-2xs font-semibold uppercase tracking-wide ${STATUS_CLASS[risk.status]}`}
        >
          {risk.status === "open" ? "check yourself" : "possibly related"}
        </span>
      </div>
      <p className="hypothesis-risk-statement m-0 mb-1 font-serif text-base leading-snug text-ink">
        {risk.statement}
      </p>
      <p className="hypothesis-risk-disconfirm m-0 font-serif text-sm leading-snug text-ink-faint">
        {risk.disconfirmer}
      </p>
      {risk.findingIds.length > 0 ? (
        <div className="hypothesis-risk-findings mt-2 flex flex-wrap gap-1.5">
          {risk.findingIds.map((findingId) => (
            <button
              type="button"
              className="hypothesis-finding-jump rounded-chip border border-line bg-raised px-2.5 py-1 text-xs font-semibold text-ink-soft hover:border-accent-line hover:text-accent"
              data-jump-finding={findingId}
              key={findingId}
              onClick={() => onJumpToFinding(findingId)}
            >
              view finding
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function HypothesisReadingFrame({
  frame,
  onJumpToFinding,
}: {
  frame: HypothesisFrame;
  onJumpToFinding(findingId: string): void;
}) {
  return (
    <section
      className="hypothesis-frame flex flex-col gap-4 border-t border-line p-4 font-sans"
      aria-label="Review hypothesis"
    >
      <header className="hypothesis-frame-head flex items-baseline justify-between gap-3">
        {/* Chrome, terse (Design Doctrine §4, ≤4 words): the section names itself, the
            model-voiced domain/scope/design/risks below carry the meaning. */}
        <p className="hypothesis-frame-title m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          What we expected
        </p>
        {frame.repoContextPresent ? null : (
          <p
            className="hypothesis-degraded m-0 text-2xs font-semibold uppercase tracking-wide text-accent"
            role="note"
          >
            Formed without repo context
          </p>
        )}
      </header>

      <div className="hypothesis-domain">
        <h3 className="hypothesis-label m-0 mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          Domain
        </h3>
        <p className="m-0 font-serif text-base leading-relaxed text-ink-soft">{frame.domain}</p>
      </div>

      <div className="hypothesis-scope">
        <h3 className="hypothesis-label m-0 mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          Scope
        </h3>
        <div className="hypothesis-scope-cols grid grid-cols-2 gap-3">
          <div className="hypothesis-scope-in">
            <span className="hypothesis-scope-tag mb-1 inline-block text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              In
            </span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {frame.scope.inScope.map((item) => (
                <li key={item} className="font-serif text-base leading-snug text-ink-soft">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="hypothesis-scope-out">
            <span className="hypothesis-scope-tag mb-1 inline-block text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              Out
            </span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {frame.scope.outOfScope.map((item) => (
                <li key={item} className="font-serif text-base leading-snug text-ink-soft">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="hypothesis-design">
        <h3 className="hypothesis-label m-0 mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          Design we'd have chosen
        </h3>
        <p className="m-0 font-serif text-base leading-relaxed text-ink-soft">
          {frame.designExpectation}
        </p>
      </div>

      <div className="hypothesis-risks">
        <div className="hypothesis-risks-head mb-2 flex items-baseline justify-between gap-3">
          <h3 className="hypothesis-label m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            Risks to check
          </h3>
          <span className="hypothesis-risk-counts inline-flex gap-2 text-xs font-semibold">
            <span className="hypothesis-count hypothesis-count-open text-accent">
              {frame.counts.open} open
            </span>
            <span className="hypothesis-count hypothesis-count-confirmed text-ink-faint">
              {frame.counts.confirmed} related
            </span>
          </span>
        </div>
        {/* The all-matched caveat (P0-1): "0 open" must never read as "nothing to worry
            about." When EVERY predicted risk drew only a lexical match, say plainly that
            none was verified — a content caveat (it breathes, like the failed-runner
            banners) so a screen of "possibly related" is not mistaken for an all-clear. */}
        {frame.counts.open === 0 && frame.counts.confirmed > 0 ? (
          <p
            className="hypothesis-all-related m-0 mb-2 rounded-surface border border-accent-line bg-accent-surface px-3 py-2 text-sm leading-snug text-ink"
            role="note"
          >
            Every predicted risk drew only a lexical match — none was verified. Judge each yourself.
          </p>
        ) : null}
        <ol className="hypothesis-risk-list m-0 flex list-none flex-col gap-2 p-0">
          {frame.risks.map((risk) => (
            <RiskRow key={risk.riskId} risk={risk} onJumpToFinding={onJumpToFinding} />
          ))}
        </ol>
      </div>
    </section>
  );
}
