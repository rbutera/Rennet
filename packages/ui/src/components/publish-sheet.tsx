import { useRef, useState } from "react";
import {
  canSign,
  type DestinationVariant,
  ledgerBlocksSign,
  type PublishLedger,
  resolveSign,
} from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";

// ─────────────────────────────────────────────────────────────────────────────
// The PAPER (issue #22 core; NARROWED by R40, issue #101). The ONLY solid object
// in the glass system, showing the ACTUAL outbound artifact — exactly what leaves
// the machine. It signs the WHOLE set behind a hold-to-confirm gate.
//
// R40 narrowing: the paper's ONLY actions are SIGN and BACK. Editing (reword,
// retype, reorder, merge, split, WITHDRAW) has moved OFF the paper and ONTO the
// collation draft canvas (issue #101). The old inline `onWithdraw` is GONE — a
// subset is shipped by withdrawing on the DRAFT first, then signing. Signing is a
// phase transition: the glass draft crystallises into this paper.
//
// The paper is handed the EXACT outbound bytes (`payload`) and the ordered item
// list (`items`) it renders — it never re-derives or re-sorts them. So "what you
// see is what leaves" holds by construction: the previewed `<pre>` and the signed
// bytes are the SAME `payload` prop, and the ordered list reflects the draft order
// the user composed (not a path-sort).
//
// Ratified rulings encoded: publish is all-or-nothing per signing act for v1 (no
// partial selection here); the sign gate never defaults to APPROVE.
//
// The #80 sign-gate mechanics (`resolveSign`, `ledgerBlocksSign`, hold budget,
// keyboard sign, auto-repeat guard, ledger-swap fail-closed, honesty affordance)
// are reused UNCHANGED — only the payload SOURCE moved from a batch it re-derived
// to bytes it is handed. Deferred seams: the real degradation ledger's content
// (#22/council), three-phase idempotent publish (#22/R17), and the GitHub publish
// pipeline (#21). This slice performs ZERO Git/GitHub mutation.
// ─────────────────────────────────────────────────────────────────────────────

export function PublishSheet({
  items,
  payload,
  variant,
  holdToSignMs = 800,
  ledger,
  onSign,
  onBack,
  onClose,
}: {
  /** The ordered outbound list, for legibility. Rendered as-given (draft order). */
  items: DispositionWrite[];
  /**
   * The EXACT outbound bytes. Previewed verbatim and signed verbatim — the paper
   * never transforms them, so preview == outbound holds by construction.
   */
  payload: string;
  variant: DestinationVariant;
  /** Hold budget before a sign is permitted; accessibility floor 0 signs immediately. */
  holdToSignMs?: number;
  /**
   * The run-degradation ledger (issue #80 / bead idwba). When present with ≥1
   * entry, EVERY sign path is blocked until the reviewer acknowledges it. Absent
   * or empty → no gate. #22/council maps real run degradation into this view-model.
   */
  ledger?: PublishLedger;
  onSign?: (payload: string) => void;
  /** Back to the collation draft — editing lives there, never here (R40). */
  onBack?: () => void;
  onClose?: () => void;
}) {
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
    // clearing the pointer hold — so it signs at ANY hold budget. It can never
    // auto-approve: nothing signs without an intentional keypress on the focused
    // control. It routes through the SAME degradation gate and emits EXACTLY the
    // previewed bytes (never a transform).
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

  // Stable React keys for a positional, id-less outbound list where two items may
  // legitimately share a path (a split on the draft). We disambiguate by a per-path
  // OCCURRENCE counter rather than the array index, so a duplicate-path pair gets
  // distinct, order-stable keys without leaning on the index the lint rule guards.
  const seenByPath = new Map<string, number>();
  const itemKeys = items.map((entry) => {
    const occurrence = seenByPath.get(entry.path) ?? 0;
    seenByPath.set(entry.path, occurrence + 1);
    return { entry, key: `${entry.path}#${occurrence}` };
  });

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
            ? "Nothing collated. Go back to the draft and dispose something first — this paper is what leaves the machine."
            : `Exactly what will leave the machine: ${items.length} disposition${
                items.length === 1 ? "" : "s"
              }, in the order you composed.`}
        </p>

        <ol className="publish-sheet-items" aria-label="Outbound artifact">
          {itemKeys.map(({ entry, key }) => (
            <li className="publish-sheet-item" data-path={entry.path} key={key}>
              <span className="publish-sheet-item-type" data-type={entry.type}>
                {entry.type}
              </span>
              <span className="publish-sheet-item-path">{entry.path}</span>
              <span className="publish-sheet-item-body">
                {entry.body.trim() === "" ? "(no note)" : entry.body}
              </span>
            </li>
          ))}
        </ol>

        {/* The exact outbound bytes, machine-readable: previewed bytes == the
            `payload` prop == what `onSign` emits. Rendered so a reviewer (and a
            test) can verify what will leave, not eyeball it. */}
        <pre className="publish-sheet-preview" data-testid="publish-preview">
          {payload}
        </pre>

        {/* The degradation-ledger sign-gate (issue #80). When the run degraded, the
            reviewer cannot sign until they acknowledge what degraded — the honesty
            the paper/glass doctrine demands. Absent/empty ledger → not rendered. */}
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
            All-or-nothing: signing publishes the whole set. To leave something out, go back and
            withdraw it on the draft.
          </p>
          <div className="publish-sheet-foot-actions">
            {/* The paper's OTHER action (R40): back to the draft, where editing
                lives. The paper itself is sign-only. */}
            <button type="button" className="publish-sheet-back" onClick={() => onBack?.()}>
              ← Back to the draft
            </button>
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
          </div>
        </footer>
      </section>
    </div>
  );
}
