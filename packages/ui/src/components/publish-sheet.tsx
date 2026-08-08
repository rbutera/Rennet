import { useRef, useState } from "react";
import {
  bucketLedgerEntries,
  canSign,
  type DestinationVariant,
  LEDGER_BUCKET_LABEL,
  ledgerBlocksSign,
  type PublishLedger,
  resolveSign,
} from "../canvas/destination";
import type { DispositionWrite } from "../canvas/logic";
import {
  type PrSubmission,
  type PublishTarget,
  type ReviewComment,
  targetItemCount,
} from "../canvas/publish";

// ─────────────────────────────────────────────────────────────────────────────
// The PAPER (issue #22 core; NARROWED by R40, issue #101). The ONLY solid object
// in the glass system, showing the ACTUAL outbound artifact — exactly what leaves
// the machine. It signs the WHOLE set behind a hold-to-confirm gate.
//
// R40 narrowing: the paper's ONLY actions are SIGN and BACK. Editing (reword,
// retype, reorder, merge, split, WITHDRAW) has moved OFF the paper and ONTO the
// collation draft canvas (issue #101). Signing is a phase transition: the glass
// draft crystallises into this paper.
//
// #22 content: the paper is CONTEXT-DEPENDENT. Handed a `target`, it previews the
// variant-specific outbound artifact — the PR SUBMISSION (own-branch) or the
// line-anchored REVIEW (other-pr) — both derived from the one collation draft. The
// bytes it previews and signs are `payload` == `publishTargetPayload(target)`, so
// "what you see is what leaves" (R33) holds by construction across BOTH variants.
// With no `target` it renders the legacy ordered `items` list (the #80 gate tests'
// path), so the safety mechanics are exercised unchanged.
//
// The paper is handed the EXACT outbound bytes (`payload`) it renders and signs —
// it never re-derives or re-sorts them. The #80 sign-gate mechanics (`resolveSign`,
// `ledgerBlocksSign`, hold budget, keyboard sign, auto-repeat guard, ledger-swap
// fail-closed, honesty affordance) are reused UNCHANGED — only the CONTENT above
// the gate grew. This slice performs ZERO Git/GitHub mutation: the own-branch PR
// submission is a PREVIEW; creation is a separate explicit act (#21), and Rennet
// never pushes source.
// ─────────────────────────────────────────────────────────────────────────────

export function PublishSheet({
  items = [],
  payload,
  variant,
  target,
  holdToSignMs = 800,
  ledger,
  onSign,
  onBack,
  onClose,
}: {
  /**
   * The ordered outbound list, for the legacy (no-`target`) render. Rendered
   * as-given (draft order). When a `target` is present this is ignored — the
   * variant-specific preview renders instead.
   */
  items?: DispositionWrite[];
  /**
   * The EXACT outbound bytes. Previewed verbatim and signed verbatim — the paper
   * never transforms them, so preview == outbound holds by construction. When a
   * `target` is present this MUST equal `publishTargetPayload(target)`.
   */
  payload: string;
  variant: DestinationVariant;
  /**
   * The variant-specific outbound artifact (issue #22): the PR submission
   * (own-branch) or the line-anchored review (other-pr). Both are derived from the
   * one collation draft, so the two variants are two framings of one review state.
   * Absent → the legacy `items` list renders (the #80 gate-test path).
   */
  target?: PublishTarget;
  /** Hold budget before a sign is permitted; accessibility floor 0 signs immediately. */
  holdToSignMs?: number;
  /**
   * The run-degradation ledger (issue #80 gate / #22 content). When present with ≥1
   * entry, EVERY sign path is blocked until the reviewer acknowledges it. Absent or
   * empty → no gate. The entries carry #22 `kind`/`detail`/`counts` the sheet
   * DISPLAYS in buckets; the gate keys only on id + summary (see `ledgerSignature`).
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
  // gate exists to stop. Track the stable SIGNATURE over EVERY acknowledgement-
  // relevant field the reviewer inspects: each entry's id, summary, kind, and detail,
  // PLUS the read-vs-attested counts (#22 content). A council may reuse an entry id
  // while its degradation TEXT, bucket kind, orphaned-path detail, or attestation
  // counts change — each a new, unacknowledged degradation — and a signature that
  // omitted any of them would carry the stale ack across it and fail OPEN. Using
  // the content (not object identity, which an un-memoized host would change every
  // render, resetting the ack on every keystroke and defeating the gate the other
  // way) keeps the signature stable across re-renders yet re-arms the render a
  // genuinely-new degradation set arrives. This is React's "adjust state when a prop
  // changes" pattern: synchronous during render, so the gate re-arms with no flash.
  const ledgerSignature = JSON.stringify({
    entries: ledgerEntries.map((entry) => [entry.id, entry.summary, entry.kind, entry.detail]),
    counts: ledger?.counts ?? null,
  });
  const [ackSignature, setAckSignature] = useState(ledgerSignature);
  if (ledgerSignature !== ackSignature) {
    setAckSignature(ledgerSignature);
    setAcknowledged(false);
  }

  // How many dispositions are outbound, for the empty/disabled state. From the
  // target when present (the true outbound count for the variant), else the list.
  const itemCount = target ? targetItemCount(target) : items.length;

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
          {itemCount === 0
            ? "Nothing collated. Go back to the draft and dispose something first — this paper is what leaves the machine."
            : target?.mode === "own-branch"
              ? "Exactly what will leave the machine: the pull request this branch submits. Creating it is a separate act — nothing is pushed from here."
              : `Exactly what will leave the machine: ${itemCount} ${
                  target ? "review comment" : "disposition"
                }${itemCount === 1 ? "" : "s"}, in the order you composed.`}
        </p>

        {/* The variant-specific outbound preview (issue #22). Both variants are
            rendered from the one collation draft the `target` was derived from. */}
        {target ? renderTarget(target) : renderItems(items)}

        {/* The exact outbound bytes, machine-readable: previewed bytes == the
            `payload` prop == what `onSign` emits. Rendered so a reviewer (and a
            test) can verify what will leave, not eyeball it. */}
        <pre className="publish-sheet-preview" data-testid="publish-preview">
          {payload}
        </pre>

        {/* The degradation-ledger sign-gate (issue #80) + its #22 content. When the
            run degraded, the reviewer cannot sign until they acknowledge what
            degraded. Entries are bucketed by kind and the read-vs-attested counts
            are stated honestly. Absent/empty ledger → not rendered. */}
        {hasLedger ? (
          <fieldset className="publish-sheet-ledger">
            <legend className="publish-sheet-ledger-legend">Run degradations to acknowledge</legend>
            <p className="publish-sheet-ledger-lede">
              This run degraded. Signing is blocked until you acknowledge what happened.
            </p>
            {ledger?.counts ? (
              <p className="publish-sheet-ledger-counts" data-testid="ledger-counts">
                {ledger.counts.attested} of {ledger.counts.total} attested · {ledger.counts.read}{" "}
                read
              </p>
            ) : null}
            {bucketLedgerEntries(ledgerEntries).map((bucket) => (
              <div
                className="publish-sheet-ledger-bucket"
                data-bucket={bucket.kind ?? "other"}
                key={bucket.kind ?? "other"}
              >
                {bucket.kind ? (
                  <p className="publish-sheet-ledger-bucket-label">
                    {LEDGER_BUCKET_LABEL[bucket.kind]}
                  </p>
                ) : null}
                <ul className="publish-sheet-ledger-entries">
                  {bucket.entries.map((entry) => (
                    <li
                      className="publish-sheet-ledger-entry"
                      data-ledger-id={entry.id}
                      key={entry.id}
                    >
                      {entry.summary}
                      {entry.detail ? (
                        <span className="publish-sheet-ledger-detail">{entry.detail}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
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
              disabled={itemCount === 0}
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

// ── The legacy ordered list (no `target`) — the #80 gate-test render ─────────

function renderItems(items: DispositionWrite[]) {
  // Stable React keys for a positional, id-less outbound list where two items may
  // legitimately share a path (a split on the draft). We disambiguate by a per-path
  // OCCURRENCE counter rather than the array index.
  const seenByPath = new Map<string, number>();
  return (
    <ol className="publish-sheet-items" aria-label="Outbound artifact">
      {items.map((entry) => {
        const occurrence = seenByPath.get(entry.path) ?? 0;
        seenByPath.set(entry.path, occurrence + 1);
        return (
          <li
            className="publish-sheet-item"
            data-path={entry.path}
            key={`${entry.path}#${occurrence}`}
          >
            <span className="publish-sheet-item-type" data-type={entry.type}>
              {entry.type}
            </span>
            <span className="publish-sheet-item-path">{entry.path}</span>
            <span className="publish-sheet-item-body">
              {entry.body.trim() === "" ? "(no note)" : entry.body}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ── The variant-specific outbound preview (issue #22) ────────────────────────

function renderTarget(target: PublishTarget) {
  return target.mode === "own-branch"
    ? renderPrSubmission(target.submission)
    : renderReviewComments(target.comments);
}

/**
 * The own-branch PR submission preview: title, base←head, draft state, and the
 * composed body. This is a PREVIEW of what a later explicit act (#21) would create
 * — the sheet performs NO Git/GitHub mutation, which is why the composition is a
 * pure derivation of the draft.
 */
function renderPrSubmission(submission: PrSubmission) {
  return (
    <div className="publish-sheet-pr" data-testid="pr-submission">
      <div className="publish-sheet-pr-head">
        <span className="publish-sheet-pr-state" data-draft={submission.draft}>
          {submission.draft ? "Draft" : "Ready"}
        </span>
        <h3 className="publish-sheet-pr-title">{submission.title}</h3>
      </div>
      <p className="publish-sheet-pr-branches" data-testid="pr-branches">
        <code className="publish-sheet-pr-base">{submission.base}</code>
        <span aria-hidden="true"> ← </span>
        <code className="publish-sheet-pr-head-ref">{submission.head}</code>
      </p>
      <div className="publish-sheet-pr-body" data-testid="pr-body">
        {submission.body.trim() === "" ? "(no description)" : submission.body}
      </div>
      <p className="publish-sheet-pr-note" role="note">
        Signing previews the submission. Creating the pull request is a separate act — nothing is
        pushed from here.
      </p>
    </div>
  );
}

/**
 * The other-pr review comments preview: every disposition as a line-anchored
 * comment (path:line side), in draft order. A comment with no span anchor shows as
 * a file-level comment, honestly. An unrefined body carries a "raw" marker until
 * #19's refinement loop lands.
 */
function renderReviewComments(comments: readonly ReviewComment[]) {
  const seenByPath = new Map<string, number>();
  return (
    <ol className="publish-sheet-comments" aria-label="Review comments to post">
      {comments.map((comment) => {
        const occurrence = seenByPath.get(comment.path) ?? 0;
        seenByPath.set(comment.path, occurrence + 1);
        const anchorLabel =
          comment.line !== undefined ? `${comment.path}:${comment.line}` : `${comment.path}`;
        return (
          <li
            className="publish-sheet-comment"
            data-path={comment.path}
            data-line={comment.line ?? "file"}
            data-side={comment.side}
            key={`${comment.path}#${occurrence}`}
          >
            <span className="publish-sheet-item-type" data-type={comment.type}>
              {comment.type}
            </span>
            <span className="publish-sheet-comment-anchor">
              {anchorLabel}
              {comment.line === undefined ? (
                <span className="publish-sheet-comment-file"> (file)</span>
              ) : (
                <span className="publish-sheet-comment-side"> {comment.side}</span>
              )}
            </span>
            {comment.refined ? null : (
              <span
                className="publish-sheet-comment-raw"
                data-testid="comment-raw"
                title="Raw — the refined form lands with #19"
              >
                raw
              </span>
            )}
            <span className="publish-sheet-item-body">
              {comment.body.trim() === "" ? "(no note)" : comment.body}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
