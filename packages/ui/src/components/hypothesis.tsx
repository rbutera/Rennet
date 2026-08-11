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

function RiskRow({
  risk,
  onJumpToFinding,
}: {
  risk: HypothesisFrameRisk;
  onJumpToFinding(findingId: string): void;
}) {
  return (
    <li className="hypothesis-risk" data-severity={risk.severity} data-status={risk.status}>
      <div className="hypothesis-risk-head">
        <span className={`flag-severity flag-severity-${risk.severity}`}>
          {SEVERITY_LABEL[risk.severity]}
        </span>
        <span className={`hypothesis-status hypothesis-status-${risk.status}`}>
          {risk.status === "open" ? "check yourself" : "possibly related"}
        </span>
      </div>
      <p className="hypothesis-risk-statement">{risk.statement}</p>
      <p className="hypothesis-risk-disconfirm">{risk.disconfirmer}</p>
      {risk.findingIds.length > 0 ? (
        <div className="hypothesis-risk-findings">
          {risk.findingIds.map((findingId) => (
            <button
              type="button"
              className="hypothesis-finding-jump"
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
    <section className="hypothesis-frame" aria-label="Review hypothesis">
      <header className="hypothesis-frame-head">
        {/* Chrome, terse (Design Doctrine §4, ≤4 words): the section names itself, the
            model-voiced domain/scope/design/risks below carry the meaning. */}
        <p className="hypothesis-frame-title">What we expected</p>
        {frame.repoContextPresent ? null : (
          <p className="hypothesis-degraded" role="note">
            Formed without repo context
          </p>
        )}
      </header>

      <div className="hypothesis-domain">
        <h3 className="hypothesis-label">Domain</h3>
        <p>{frame.domain}</p>
      </div>

      <div className="hypothesis-scope">
        <h3 className="hypothesis-label">Scope</h3>
        <div className="hypothesis-scope-cols">
          <div className="hypothesis-scope-in">
            <span className="hypothesis-scope-tag">In</span>
            <ul>
              {frame.scope.inScope.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="hypothesis-scope-out">
            <span className="hypothesis-scope-tag">Out</span>
            <ul>
              {frame.scope.outOfScope.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="hypothesis-design">
        <h3 className="hypothesis-label">Design we'd have chosen</h3>
        <p>{frame.designExpectation}</p>
      </div>

      <div className="hypothesis-risks">
        <div className="hypothesis-risks-head">
          <h3 className="hypothesis-label">Risks to check</h3>
          <span className="hypothesis-risk-counts">
            <span className="hypothesis-count hypothesis-count-open">{frame.counts.open} open</span>
            <span className="hypothesis-count hypothesis-count-confirmed">
              {frame.counts.confirmed} related
            </span>
          </span>
        </div>
        <ol className="hypothesis-risk-list">
          {frame.risks.map((risk) => (
            <RiskRow key={risk.riskId} risk={risk} onJumpToFinding={onJumpToFinding} />
          ))}
        </ol>
      </div>
    </section>
  );
}
