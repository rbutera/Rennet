import { useRef, useState } from "react";
import type { DispositionBatch } from "../canvas/authoring";
import {
  canSign,
  type DestinationVariant,
  ledgerBlocksSign,
  type PublishLedger,
  resolveSign,
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
  ledger,
  onSign,
  onWithdraw,
  onClose,
}: {
  batch: DispositionBatch;
  variant: DestinationVariant;
  /** Hold budget before a sign is permitted; accessibility floor 0 signs immediately. */
  holdToSignMs?: number;
  /**
   * The run-degradation ledger (issue #80 / bead idwba). When present with ≥1
   * entry, EVERY sign path is blocked until the reviewer acknowledges it. Absent
   * or empty → no gate, so the shipped shell (which passes no ledger) is unchanged.
   * #22/council maps real run degradation into this thin UI-local view-model.
   */
  ledger?: PublishLedger;
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
  // The degradation-ledger acknowledgement, owned locally. A gate that clears the
  // instant the ledger renders is no gate — signing a degraded review requires an
  // explicit acknowledging act.
  const [acknowledged, setAcknowledged] = useState(false);
  const ledgerEntries = ledger?.entries ?? [];
  const hasLedger = ledgerEntries.length > 0;
  // Fail-closed on a ledger swap. `acknowledged` is component-lifetime state, so if
  // the run degradations change while the sheet stays mounted (a #22/council re-run
  // maps a NEW degradation set into `ledger`), a prior acknowledgement would carry
  // over and authorize signing the new, UNacknowledged set — the exact bypass the
  // gate exists to stop. Track the stable entry-id SIGNATURE (not object identity,
  // which an un-memoized host would change every render, resetting the ack on every
  // keystroke and defeating the gate the other way) and reset the ack the render a
  // genuinely-new entry set arrives. This is React's "adjust state when a prop
  // changes" pattern: synchronous during render, so the gate re-arms with no flash.
  const ledgerSignature = ledgerEntries.map((entry) => entry.id).join(" ");
  const [ackSignature, setAckSignature] = useState(ledgerSignature);
  if (ledgerSignature !== ackSignature) {
    setAckSignature(ledgerSignature);
    setAcknowledged(false);
  }

  function beginHold(): void {
    holdStart.current = Date.now();
    // A zero (or negative) budget is an immediate sign; arm synchronously so the
    // accessibility floor never forces a hold the user cannot perform.
    if (canSign(0, holdToSignMs)) setArmed(true);
  }

  function endHold(): void {
    const started = holdStart.current;
    holdStart.current = null;
    setArmed(false);
    if (started === null) return;
    // The degradation gate is checked BEFORE the hold gate: an unacknowledged,
    // non-empty ledger blocks every sign path regardless of hold duration.
    if (ledgerBlocksSign(ledger, acknowledged)) return;
    // The single hold gate: only a hold that clears the bar emits, and it emits
    // exactly the previewed bytes (never a transform). Below the bar, `resolveSign`
    // is null and nothing leaves — the sign never defaults to APPROVE.
    const outbound = resolveSign(Date.now() - started, holdToSignMs, payload);
    if (outbound !== null) onSign?.(outbound);
  }

  function signByKeyboard(event: { key: string; repeat?: boolean; preventDefault(): void }): void {
    // Keyboard accessibility (issue #80): an explicit Enter/Space activation of the
    // focused sign control IS the deliberate act — the keyboard equivalent of
    // clearing the pointer hold — so it signs at ANY hold budget, resolving the
    // barrier where the default non-zero hold left a keyboard/AT user unable to
    // publish at all. It can never auto-approve: nothing signs without an
    // intentional keypress on the focused control. It routes through the SAME
    // degradation gate and emits EXACTLY the previewed bytes (never a transform).
    if (event.key !== "Enter" && event.key !== " ") return;
    // Ignore keyboard auto-repeat: a HELD Enter/Space emits a stream of repeat
    // keydowns, and without this guard each one calls onSign again — a repeated
    // publish once #21 makes the sign a real Git/GitHub mutation. Only the first,
    // non-repeat activation is the deliberate act.
    if (event.repeat) return;
    event.preventDefault();
    if (ledgerBlocksSign(ledger, acknowledged)) return;
    onSign?.(payload);
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

        {/* The degradation-ledger sign-gate (issue #80). When the run degraded, the
            reviewer cannot sign until they acknowledge what degraded — the honesty
            the paper/glass doctrine demands. Absent/empty ledger → not rendered,
            no gate, shell behaviour unchanged. */}
        {hasLedger ? (
          <fieldset className="publish-sheet-ledger">
            <legend className="publish-sheet-ledger-legend">Run degradations to acknowledge</legend>
            <p className="publish-sheet-ledger-lede">
              This run degraded. Signing is blocked until you acknowledge what happened.
            </p>
            <ul className="publish-sheet-ledger-entries">
              {ledgerEntries.map((entry) => (
                <li className="publish-sheet-ledger-entry" data-ledger-id={entry.id} key={entry.id}>
                  {entry.summary}
                </li>
              ))}
            </ul>
            <label className="publish-sheet-ack">
              <input
                type="checkbox"
                className="publish-sheet-ack-box"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                Acknowledge {ledgerEntries.length} run degradation
                {ledgerEntries.length === 1 ? "" : "s"} to sign
              </span>
            </label>
          </fieldset>
        ) : null}

        {/* Honesty affordance (issue #80): under the paper/glass doctrine, a shell
            sign clears the staged paper while publishing NOTHING. This persistent,
            aria-legible notice ensures a shell sign can never read as a real
            publish. Real publishing lands in #21. */}
        <p className="publish-sheet-shell-notice" role="note">
          This shell publishes nothing — signing clears the staged paper. Real publishing lands in
          #21.
        </p>

        <footer className="publish-sheet-foot">
          <p className="publish-sheet-note">
            All-or-nothing: signing publishes the whole staged set. To leave something out, withdraw
            it first.
          </p>
          <button
            type="button"
            className={`publish-sheet-sign ${armed ? "is-arming" : ""}`}
            data-hold-ms={holdToSignMs}
            // A pointer user holds; a keyboard/AT user does not — a single Enter or
            // Space on the focused control signs. Announce that additively so the
            // "Hold to …" visible label does not mislead AT, without changing it.
            aria-keyshortcuts="Enter Space"
            disabled={items.length === 0}
            onMouseDown={beginHold}
            onMouseUp={endHold}
            onMouseLeave={() => {
              holdStart.current = null;
              setArmed(false);
            }}
            onKeyDown={signByKeyboard}
          >
            Hold to {variant.signLabel.toLowerCase()}
          </button>
        </footer>
      </section>
    </div>
  );
}
