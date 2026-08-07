import { useRef, useState } from "react";
import type { DispositionBatch } from "../canvas/authoring";
import {
  canSign,
  type DestinationVariant,
  stagedItems,
  stagedPayload,
} from "../canvas/destination";

// ─────────────────────────────────────────────────────────────────────────────
// The publish sheet SHELL (issue #22 core). The paper: the ONLY solid object in
// the glass system, showing the ACTUAL outbound artifact. It lists the staged
// items as exactly what will leave the machine — the previewed bytes ARE the
// staged payload bytes (`stagedPayload`, the #17 `batchPayload`) — and signs the
// WHOLE staged set behind a hold-to-confirm gate.
//
// Ratified rulings encoded: publish is all-or-nothing per signing act for v1 (no
// partial selection here; a subset means withdraw first, then sign); the sign
// gate never defaults to APPROVE.
//
// Deferred seams (documented, not built here): the degradation ledger + read-vs-
// attested honesty (#22), three-phase idempotent publish (#22/R17), the refined-
// comment preview forms (#19 — raw is shown until it lands), and the actual
// GitHub publish pipeline (#21). This slice performs ZERO Git/GitHub mutation.
// ─────────────────────────────────────────────────────────────────────────────

export function PublishSheet({
  batch,
  variant,
  holdToSignMs = 800,
  onSign,
  onWithdraw,
  onClose,
}: {
  batch: DispositionBatch;
  variant: DestinationVariant;
  /** Hold budget before a sign is permitted; accessibility floor 0 signs immediately. */
  holdToSignMs?: number;
  onSign?: (payload: string) => void;
  onWithdraw?: (path: string) => void;
  onClose?: () => void;
}) {
  const items = stagedItems(batch);
  // The previewed bytes ARE the outbound bytes: `stagedPayload` is the #17
  // `batchPayload`, so what the reviewer signs is exactly what is shown.
  const payload = stagedPayload(batch);

  const holdStart = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);

  function beginHold(): void {
    holdStart.current = Date.now();
    // A zero (or negative) budget is an immediate sign; arm synchronously so the
    // accessibility floor never forces a hold the user cannot perform.
    if (canSign(0, holdToSignMs)) setArmed(true);
  }

  function endHold(): void {
    const started = holdStart.current;
    holdStart.current = null;
    if (started === null) return;
    const elapsed = Date.now() - started;
    if (canSign(elapsed, holdToSignMs)) {
      setArmed(false);
      onSign?.(payload);
    } else {
      setArmed(false);
    }
  }

  return (
    <div className="publish-sheet-backdrop" role="dialog" aria-modal="true" aria-label="Publish">
      <section className="publish-sheet" data-mode={variant.mode}>
        <header className="publish-sheet-head">
          <div>
            <p className="publish-sheet-eyebrow">{variant.title}</p>
            <h2>{variant.summary}</h2>
          </div>
          <button
            type="button"
            className="publish-sheet-close"
            aria-label="Close"
            onClick={() => onClose?.()}
          >
            ×
          </button>
        </header>

        <p className="publish-sheet-lede">
          {items.length === 0
            ? "Nothing staged. Dispose something first — this paper is what leaves the machine."
            : `Exactly what will leave the machine: ${items.length} disposition${
                items.length === 1 ? "" : "s"
              }.`}
        </p>

        <ol className="publish-sheet-items" aria-label="Outbound artifact">
          {items.map((entry) => (
            <li className="publish-sheet-item" data-path={entry.path} key={entry.path}>
              <span className="publish-sheet-item-type" data-type={entry.type}>
                {entry.type}
              </span>
              <span className="publish-sheet-item-path">{entry.path}</span>
              <span className="publish-sheet-item-body">
                {entry.body.trim() === "" ? "(no note)" : entry.body}
              </span>
              {onWithdraw ? (
                <button
                  type="button"
                  className="publish-sheet-item-withdraw"
                  onClick={() => onWithdraw(entry.path)}
                >
                  Withdraw
                </button>
              ) : null}
            </li>
          ))}
        </ol>

        {/* The exact outbound bytes, machine-readable: previewed bytes == staged
            payload bytes. Rendered so a reviewer (and a test) can verify what will
            leave against `stagedPayload(batch)`, not eyeball it. */}
        <pre className="publish-sheet-preview" data-testid="publish-preview">
          {payload}
        </pre>

        <footer className="publish-sheet-foot">
          <p className="publish-sheet-note">
            All-or-nothing: signing publishes the whole staged set. To leave something out, withdraw
            it first.
          </p>
          <button
            type="button"
            className={`publish-sheet-sign ${armed ? "is-arming" : ""}`}
            data-hold-ms={holdToSignMs}
            disabled={items.length === 0}
            onMouseDown={beginHold}
            onMouseUp={endHold}
            onMouseLeave={() => {
              holdStart.current = null;
              setArmed(false);
            }}
            onKeyDown={(event) => {
              // Keyboard accessibility: Enter/Space performs the sign, honouring
              // the floor-0 gate. A non-zero hold is a pointer affordance.
              if ((event.key === "Enter" || event.key === " ") && canSign(0, holdToSignMs)) {
                event.preventDefault();
                onSign?.(payload);
              }
            }}
          >
            Hold to {variant.signLabel.toLowerCase()}
          </button>
        </footer>
      </section>
    </div>
  );
}
