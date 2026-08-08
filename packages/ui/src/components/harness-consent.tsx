import type { PermissionMode } from "@rennet/protocol";

/**
 * The harness-run disclosure/consent affordance (issue #58, routed through the
 * permission mode of issue #103). Shown in the Canvases view when the effective
 * mode ASKS (manual) and this review's harness run has not yet been consented.
 *
 * Per R31 (per-run context disclosure): it names WHAT will run and over WHICH
 * repository before any harness turn composes. The deterministic floor / demo
 * canvases are already on screen behind it — only the model-enrichment turns
 * gate here.
 *
 *   - "Run this review" → consent for THIS review only (a per-run allow; the
 *     persisted workspace mode is unchanged).
 *   - "Always run automatically" → opt the workspace default up to `auto`.
 */
export function HarnessConsent({
  repositoryRoot,
  mode,
  onConsent,
  onAlwaysAuto,
}: {
  repositoryRoot: string;
  mode: PermissionMode;
  onConsent(): void;
  onAlwaysAuto(): void;
}) {
  return (
    <section className="harness-consent" role="dialog" aria-label="Run the review harness?">
      <div className="harness-consent-body">
        <p className="eyebrow">PERMISSION · {mode.toUpperCase()}</p>
        <h2>Run the review harness?</h2>
        <p>
          Opening Canvases runs your installed review harness (Claude, plus the model council) over
          the captured diff in <code>{repositoryRoot}</code>: decomposition, ordering, and roll-up
          narration turns on your own subscription. Nothing is sent until you say so.
        </p>
        <div className="harness-consent-actions">
          <button type="button" className="harness-consent-run" onClick={onConsent}>
            Run this review
          </button>
          <button type="button" className="harness-consent-auto secondary" onClick={onAlwaysAuto}>
            Always run automatically
          </button>
        </div>
      </div>
    </section>
  );
}
