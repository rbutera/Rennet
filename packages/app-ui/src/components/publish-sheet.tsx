import type { DecompositionBlockingState } from "@rennet/types";
import { ArrowLeft } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
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
  publishTargetAgrees,
  type ReviewComment,
  targetItemCount,
} from "../canvas/publish";
import { BlockedIngestionDisclosure } from "./flagged";
import { Icon } from "./icon";
import { Prose } from "./prose";

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
// the gate grew. The own-branch sign is a REAL act (issue #257 / #107): a completed
// hold pushes the branch and opens the PR — pushing your own branch is not
// publishing (AGENTS.md), and the sign-click is the whole authorization.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outcome of a sign that ran the real `publish.review` engine (bead
 * wire-sign-publish). The wire dry-runs by default: it builds the exact GitHub
 * request, runs the "what you see is what leaves" integrity check, and posts
 * NOTHING. This summary is what the paper shows the human once the engine returns,
 * replacing the pre-sign notice.
 */
export interface PublishReviewResult {
  /** True ⇒ nothing left the machine (the default). */
  readonly dryRun: boolean;
  /** The resolved review verdict the engine would post. */
  readonly verdict: string;
  /** How many comments the review carried. */
  readonly count: number;
  /** The human label for the target (`local/<name>#<number>` on a local preview). */
  readonly targetLabel: string;
  /** The constructed request endpoint (the forge GraphQL URL). */
  readonly endpoint: string;
  /** The request method (POST). */
  readonly method: string;
  /** The deterministic idempotency marker embedded in the review body. */
  readonly marker: string;
  /** How many degradations the run recorded (surfaced, never silent). */
  readonly ledgerCount: number;
  /** True when the target is a local-capture preview (no real PR bound yet). */
  readonly preview: boolean;
}

/**
 * The outcome of an own-branch sign (issue #257 / #107): the branch was pushed and a
 * real pull request was opened. Carries the created PR's URL + number so the paper can
 * surface it, and whether an already-open PR from the same head was reused (idempotent).
 */
export interface PrSubmittedResult {
  /** The created (or reused) pull request's web URL. */
  readonly url: string;
  /** The pull request number. */
  readonly number: number;
  /** True when an open PR from this head already existed and was reused. */
  readonly reused: boolean;
}

/**
 * The outcome of a sign, discriminated by destination mode (issue #109). The two modes
 * sign two DIFFERENT artifacts, so their outcomes differ:
 *   • `review`    — an OTHER-PR sign that ran the wired `publish.review` engine. Carries
 *     the dry-run summary above.
 *   • `submitted` — an OWN-BRANCH sign (issue #257). The branch was pushed and a real
 *     pull request was opened with the drafted title/body; the PR URL surfaces here.
 */
export type PublishOutcome =
  | ({ readonly kind: "review" } & PublishReviewResult)
  | ({ readonly kind: "submitted" } & PrSubmittedResult);

export function PublishSheet({
  items = [],
  payload,
  variant,
  target,
  holdToSignMs = 800,
  ledger,
  result,
  willPost = false,
  postLabel,
  pending = false,
  blockingStates = [],
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
  /**
   * The result of the last sign that ran the publish engine. Present ⇒ the paper
   * shows the actual dry-run outcome (what would leave the machine) in place of the
   * pre-sign notice. Absent ⇒ the pre-sign notice describes what a sign will do.
   */
  result?: PublishOutcome;
  /**
   * True when a completed hold-to-sign will perform a REAL GitHub post (issue #21):
   * the review was opened from a real pull request. It changes ONLY the pre-sign
   * copy — the notice states honestly that signing posts to GitHub, rather than the
   * dry-run copy — so a real post is never described as "posts nothing". The gate
   * mechanics are unchanged: the human's hold is still the sole trigger. Default
   * false ⇒ the local-capture dry-run copy (the existing behaviour).
   */
  willPost?: boolean;
  /** The real post destination label (`owner/name#number`), shown in the real-post notice. */
  postLabel?: string;
  /**
   * A publish is in flight (issue #21): disables the sign control so a second sign
   * cannot start while the first is still landing. The synchronous re-entry guard in
   * the caller is the real protection; this is its visible reflection.
   */
  pending?: boolean;
  /**
   * Incomplete-ingestion blockers (R18, issue #309) for the review being signed. When
   * non-empty, the sheet discloses them before the sign control so a signer knows the
   * review ran over partially-ingested content. RENDER-ONLY honest copy: it NEVER
   * feeds `ledgerBlocksSign`, `resolveSign`, the ack state, or the ledger signature —
   * per Rule Zero it adds no gate, delay, or acknowledgement to the sign path. Absent
   * or empty ⇒ no disclosure, and the sheet is byte-identical to its pre-#309 form.
   */
  blockingStates?: readonly DecompositionBlockingState[];
  onSign?: (payload: string) => void;
  /** Back to the collation draft — editing lives there, never here (R40). */
  onBack?: () => void;
  onClose?: () => void;
}) {
  const holdStart = useRef<number | null>(null);
  // The exact bytes the CURRENT hold began over (#74 HIGH-2). The paper is a freeze,
  // but its `payload` prop can still be recomposed by the host while the sheet stays
  // mounted — a late "Draft with AI" result changes `prDraft`, which recomposes the
  // target and re-renders the paper with NEW bytes. `holdStart` is a ref that
  // survives that re-render, so without this a hold begun over payload A would sign
  // payload B on release, with no fresh hold over B. Binding the hold to the bytes it
  // started over makes signing emit ONLY what the reviewer actually held over.
  const holdPayload = useRef<string | null>(null);
  const [armed, setArmed] = useState(false);
  // Hold-progress feedback (critique P1-C). `holding` is true for the whole press so the
  // fill can animate the hold budget; `releasedEarly` surfaces the honest "you let go too
  // soon" reassurance after a below-budget release. Neither gates the sign — the hold is
  // the sole authorization (Rule Zero); these only make the existing hold LEGIBLE.
  const [holding, setHolding] = useState(false);
  const [releasedEarly, setReleasedEarly] = useState(false);
  // Capture the hold-eligibility epoch in the SAME committed render that arms the fill's
  // animation (critique fix): `beginHold` flips `holding` true, and this layout effect —
  // running after that commit, before paint — stamps `holdStart`. The `.is-holding`
  // animation begins on the same commit's paint, so the JS eligibility clock and the CSS
  // fill share one origin. Stamping in the pointer-down handler instead (as before) set the
  // epoch a full render earlier than the fill, letting eligibility precede visual 100%.
  useLayoutEffect(() => {
    if (holding) holdStart.current = Date.now();
  }, [holding]);
  // A hold begun over a stale payload is voided at release by the `endHold` guard
  // (below), which is timing-independent and load-bearing. As a render-time visual,
  // disarm the button the moment the payload identity changes so it does not look
  // held over bytes the reviewer can no longer see — React's "adjust state during
  // render" pattern (the same one the ledger-swap gate uses), not an effect.
  if (armed && holdStart.current !== null && holdPayload.current !== payload) {
    holdStart.current = null;
    holdPayload.current = null;
    setArmed(false);
  }
  // Stop the progress fill the instant the bytes change mid-hold (critique P1-C): the
  // release will sign nothing (the `endHold` stale guard below), so a fill that kept
  // growing would falsely imply a valid hold. Same render-time adjust pattern as above.
  if (holding && holdPayload.current !== null && holdPayload.current !== payload) {
    setHolding(false);
  }
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

  // Fail-closed on a payload/variant/target DISAGREEMENT (issue #106; defense in
  // depth for R33 "what you see is what leaves"). The paper renders the structured
  // card from `target` yet signs the INDEPENDENT `payload` and frames the sheet with
  // the INDEPENDENT `variant`. Nothing structurally forces `payload ===
  // publishTargetPayload(target)` or `variant.mode === target.mode`, so a caller
  // whose props diverged would show ONE artifact (the card) while signing ANOTHER
  // (the bytes) under a mislabelling frame — the exact disagreement R33 forbids.
  // When a `target` is present and it disagrees, the sheet BLOCKS signing (both
  // paths) and marks the paper as blocked, rather than emitting a mismatched
  // payload. With no `target` (the legacy `items` path) there is nothing to
  // disagree with, so this never blocks that path. The live caller derives both
  // props from the one `publishTargetForMode`, so this never fires in production —
  // it is a fail-closed backstop, not a live gate.
  const targetBlocksSign =
    target !== undefined && !publishTargetAgrees(target, payload, variant.mode);

  // The single source of truth for the sign button's disabled state — used by the
  // button AND the guard below, so they can never diverge.
  const signDisabled =
    itemCount === 0 || targetBlocksSign || pending || ledgerBlocksSign(ledger, acknowledged);

  // Cancel an in-flight hold the instant the button becomes disabled. A disabled
  // button eats the mouseup/keyup, so `endHold` never runs — `holding` would stay
  // true. Then a later re-enable + fresh press calls `setHolding(true)` on an
  // already-true value: a no-op that never re-fires the [holding] epoch stamp, so the
  // release measures against the STALE press timestamp and a sub-budget hold signs.
  // Fully clearing the hold here forces the next press to be a real false→true
  // transition that re-stamps the epoch.
  useLayoutEffect(() => {
    if (signDisabled) {
      holdStart.current = null;
      holdPayload.current = null;
      setHolding(false);
      setArmed(false);
    }
  }, [signDisabled]);

  function beginHold(): void {
    // Bind this hold to the exact bytes on screen NOW (#74 HIGH-2), so a later
    // recomposition cannot make the release sign different bytes. The eligibility
    // epoch (`holdStart`) is stamped by the layout effect on the resulting commit, so
    // it lands on the same render that arms the fill animation (see above).
    holdPayload.current = payload;
    // Show the progress fill for the whole hold (critique P1-C), and clear any prior
    // "released too soon" note — a fresh attempt starts clean.
    setHolding(true);
    setReleasedEarly(false);
    // A zero (or negative) budget is an immediate sign; arm synchronously so the
    // accessibility floor never forces a hold the user cannot perform.
    if (canSign(0, holdToSignMs)) setArmed(true);
  }

  function endHold(): void {
    const started = holdStart.current;
    const heldOver = holdPayload.current;
    holdStart.current = null;
    holdPayload.current = null;
    setArmed(false);
    setHolding(false);
    if (started === null) return;
    // The bytes changed between the press and the release (#74 HIGH-2): the hold was
    // over a payload the reviewer is no longer looking at. Sign NOTHING — a new hold
    // over the current bytes is required. Timing-independent backstop to the effect.
    if (heldOver !== payload) return;
    // The target-disagreement gate is checked FIRST (issue #106): if the signed
    // `payload`/`variant` disagree with the rendered `target`, no sign path emits —
    // the paper fails closed rather than publish a mismatched artifact.
    if (targetBlocksSign) return;
    // The degradation gate is checked BEFORE the hold gate: an unacknowledged,
    // non-empty ledger blocks every sign path regardless of hold duration.
    if (ledgerBlocksSign(ledger, acknowledged)) return;
    // The single hold gate: only a hold that clears the bar emits, and it emits
    // exactly the previewed bytes (never a transform). Below the bar, `resolveSign`
    // is null and nothing leaves — the sign never defaults to APPROVE.
    const outbound = resolveSign(Date.now() - started, holdToSignMs, payload);
    if (outbound !== null) {
      onSign?.(outbound);
      return;
    }
    // Passed every other gate but the hold was TOO SHORT: nothing signed. Say so
    // (critique P1-C) — honest, announced reassurance that the hold is real and how to
    // complete it. This is not a new gate: the hold was already the sole trigger.
    setReleasedEarly(true);
  }

  function beginHoldByKeyboard(event: {
    key: string;
    repeat?: boolean;
    preventDefault(): void;
  }): void {
    // Keyboard accessibility (issue #80) is now a real HOLD, not a single keypress
    // (issue #21): pressing Enter/Space STARTS the hold, releasing it (see
    // `endHoldByKeyboard`) completes it, through the SAME `resolveSign` budget gate as
    // the pointer. A single tap no longer signs — because the sign is now a real GitHub
    // egress, one keypress firing a post was too easy. It stays fully keyboard-operable:
    // hold the key for the budget, then release.
    if (event.key !== "Enter" && event.key !== " ") return;
    // Ignore keyboard auto-repeat: a HELD Enter/Space emits a stream of repeat
    // keydowns; only the FIRST starts the hold, so the elapsed time is measured from
    // the true press, and a repeat never resets the clock.
    if (event.repeat) return;
    event.preventDefault();
    beginHold();
  }

  function endHoldByKeyboard(event: { key: string; preventDefault(): void }): void {
    // Releasing the key ENDS the hold, exactly like a pointer mouseup: `endHold`
    // measures the elapsed time and signs only if it cleared the budget, through the
    // same target/ledger/hold gates. A release below the budget signs nothing.
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    endHold();
  }

  function clearHold(): void {
    // Focus leaving mid-hold (blur) abandons the hold, mirroring pointer `mouseLeave`,
    // so a started-but-unreleased keyboard hold never lingers to sign later. Abandoning
    // is not "released too soon" (no note); just stop the fill.
    holdStart.current = null;
    holdPayload.current = null;
    setArmed(false);
    setHolding(false);
  }

  return (
    <div
      className="publish-sheet-backdrop fixed inset-0 z-40 grid place-items-center p-8 bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-label="Publish"
    >
      <section
        className="publish-sheet flex flex-col w-[min(720px,100%)] max-h-[calc(100vh-64px)] gap-4 p-6 rounded-window border border-sheet-line bg-sheet text-sheet-ink shadow-overlay"
        data-mode={variant.mode}
      >
        <header className="publish-sheet-head flex items-start justify-between gap-3">
          <div>
            <p className="publish-sheet-eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-sheet-soft">
              {variant.title}
            </p>
            <h2 className="mt-1 text-xl font-semibold font-serif text-sheet-ink">
              {variant.summary}
            </h2>
          </div>
          <button
            type="button"
            className="publish-sheet-close grid place-items-center h-8 w-8 rounded-control text-lg text-sheet-soft hover:bg-sheet-line"
            aria-label="Close"
            onClick={() => onClose?.()}
          >
            ×
          </button>
        </header>

        <p className="publish-sheet-lede m-0 text-base font-serif text-sheet-soft">
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
        <pre
          className="publish-sheet-preview m-0 max-h-[120px] overflow-auto p-2.5 rounded-control border border-dashed border-sheet-line font-mono text-2xs text-sheet-soft whitespace-pre-wrap break-all"
          data-testid="publish-preview"
        >
          {payload}
        </pre>

        {/* Blocked-ingestion disclosure (R18, issue #309): honest copy that the review
            ran over partially-ingested content, shown before the sign control. It is
            RENDER-ONLY — it never touches `ledgerBlocksSign`/`resolveSign`/`acknowledged`
            or any gate, so the sign path is identical with or without it (Rule Zero).
            Absent/empty ⇒ nothing renders. */}
        <BlockedIngestionDisclosure states={blockingStates} heading="Not fully ingested" />

        {/* The degradation-ledger sign-gate (issue #80) + its #22 content. When the
            run degraded, the reviewer cannot sign until they acknowledge what
            degraded. Entries are bucketed by kind and the read-vs-attested counts
            are stated honestly. Absent/empty ledger → not rendered. */}
        {hasLedger ? (
          <fieldset className="publish-sheet-ledger m-0 min-w-0 p-3 rounded-control border border-accent-line bg-accent-soft">
            <legend className="publish-sheet-ledger-legend px-1.5 text-2xs font-semibold uppercase tracking-wide text-sheet-ink">
              Run degradations to acknowledge
            </legend>
            <p className="publish-sheet-ledger-lede mt-0 mb-2 text-sm font-semibold text-sheet-ink">
              This run degraded. Signing is blocked until you acknowledge what happened.
            </p>
            {ledger?.counts ? (
              <p
                className="publish-sheet-ledger-counts mt-0 mb-2.5 text-sm font-semibold text-sheet-ink"
                data-testid="ledger-counts"
              >
                {ledger.counts.attested} of {ledger.counts.total} attested · {ledger.counts.read}{" "}
                read
              </p>
            ) : null}
            {bucketLedgerEntries(ledgerEntries).map((bucket) => (
              <div
                className="publish-sheet-ledger-bucket mb-2"
                data-bucket={bucket.kind ?? "other"}
                key={bucket.kind ?? "other"}
              >
                {bucket.kind ? (
                  <p className="publish-sheet-ledger-bucket-label mt-0 mb-1 text-2xs font-bold uppercase tracking-wide text-sheet-ink">
                    {LEDGER_BUCKET_LABEL[bucket.kind]}
                  </p>
                ) : null}
                <ul className="publish-sheet-ledger-entries m-0 pl-5 flex flex-col gap-1 list-disc">
                  {bucket.entries.map((entry) => (
                    <li
                      className="publish-sheet-ledger-entry text-sm text-sheet-ink"
                      data-ledger-id={entry.id}
                      key={entry.id}
                    >
                      {entry.summary}
                      {entry.detail ? (
                        <span className="publish-sheet-ledger-detail block font-mono text-2xs text-sheet-soft">
                          {entry.detail}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <label className="publish-sheet-ack flex items-start gap-2 text-sm font-semibold text-sheet-ink cursor-pointer">
              <input
                type="checkbox"
                className="publish-sheet-ack-box mt-0.5"
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

        {/* Fail-closed notice (issue #106): when the signed `payload`/`variant`
            disagree with the rendered `target`, the paper cannot present as ready —
            signing is blocked so no mismatched artifact leaves. aria-legible
            (role="alert") so the blocked state is announced, not merely visual. */}
        {targetBlocksSign ? (
          <p
            className="publish-sheet-mismatch-notice m-0 px-3 py-2 rounded-control bg-danger-soft text-sm text-danger"
            role="alert"
            data-testid="publish-mismatch"
          >
            This paper is blocked: the artifact shown and the bytes to sign disagree. Nothing can be
            signed until they match — go back to the draft.
          </p>
        ) : null}

        {/* The sign OUTCOME (bead wire-sign-publish). Once a sign has run the real
            `publish.review` engine, the paper shows what the engine built — the
            resolved verdict, the comment count, and the exact GitHub request it
            constructed — replacing the pre-sign notice. A dry run (the default)
            posts NOTHING; the aria-legible copy keeps that unmistakable, so a
            dry-run outcome can never read as a real publish. When no sign has run
            yet, the pre-sign notice describes what Hold-to-sign will do. */}
        {result?.kind === "review" ? (
          <div
            className="publish-sheet-result flex flex-col gap-1 p-3 rounded-control border border-sheet-line"
            data-testid="publish-result"
            data-outcome="review"
            data-dry-run={result.dryRun}
            role="status"
          >
            <p className="publish-sheet-result-line m-0 text-sm font-semibold text-sheet-ink">
              {result.dryRun
                ? `Dry run — nothing was posted. The publish engine built a ${result.verdict} review of ${result.count} comment${result.count === 1 ? "" : "s"} for ${result.targetLabel}.`
                : `Posted a ${result.verdict} review of ${result.count} comment${result.count === 1 ? "" : "s"} to ${result.targetLabel}.`}
            </p>
            <p className="publish-sheet-result-detail m-0 font-mono text-2xs text-sheet-soft">
              {result.method} {result.endpoint} · marker {result.marker.slice(0, 12)}
              {result.ledgerCount > 0
                ? ` · ${result.ledgerCount} degradation${result.ledgerCount === 1 ? "" : "s"} recorded`
                : ""}
            </p>
            {result.preview ? (
              <p className="publish-sheet-result-note m-0 text-xs text-sheet-soft" role="note">
                Local preview target — the review does not yet carry the GitHub PR coordinates the
                publish engine binds to, so this dry run targets a placeholder. Persisting the real
                target, and the explicit consented send, are the remaining #21 steps.
              </p>
            ) : null}
          </div>
        ) : result?.kind === "submitted" ? (
          // OWN-BRANCH sign (issue #257 / #107): the branch was pushed and a real pull
          // request was opened with the drafted title/body. The PR URL surfaces here.
          <div
            className="publish-sheet-result flex flex-col gap-1 p-3 rounded-control border border-sheet-line"
            data-testid="publish-result"
            data-outcome="submitted"
            role="status"
          >
            <p className="publish-sheet-result-line m-0 text-sm font-semibold text-sheet-ink">
              {result.reused
                ? `A pull request from this branch was already open — reused #${result.number}.`
                : `Pushed your branch and opened pull request #${result.number}.`}
            </p>
            <p className="publish-sheet-result-detail m-0 font-mono text-2xs">
              <a
                className="text-accent hover:underline"
                href={result.url}
                target="_blank"
                rel="noreferrer"
              >
                {result.url}
              </a>
            </p>
          </div>
        ) : variant.mode === "own-branch" ? (
          <p
            className="publish-sheet-shell-notice m-0 px-2.5 py-2 rounded-control border border-dashed border-sheet-line text-xs text-sheet-soft"
            role="note"
          >
            Hold to sign pushes your branch and opens the pull request on GitHub, as you. This is
            the one action that leaves the machine — nothing is pushed until you complete the hold.
          </p>
        ) : willPost ? (
          <p
            className="publish-sheet-shell-notice m-0 px-2.5 py-2 rounded-control border border-dashed border-sheet-line text-xs text-sheet-soft"
            data-testid="will-post-notice"
            role="note"
          >
            Hold to sign posts this review to {postLabel ?? "the pull request"} on GitHub, as you.
            This is the one action that leaves the machine — nothing posts until you complete the
            hold.
          </p>
        ) : (
          <p
            className="publish-sheet-shell-notice m-0 px-2.5 py-2 rounded-control border border-dashed border-sheet-line text-xs text-sheet-soft"
            role="note"
          >
            Hold to sign runs the publish engine in dry run: it builds the exact GitHub request and
            posts nothing (this review has no pull request to post to).
          </p>
        )}

        <footer className="publish-sheet-foot flex flex-col gap-3">
          <p className="publish-sheet-note m-0 text-sm text-sheet-soft">
            All-or-nothing: signing publishes the whole set. To leave something out, go back and
            withdraw it on the draft.
          </p>
          {/* Released-too-soon reassurance (critique P1-C): announced (role="status"), shown
              only after a below-budget release. Honest, not a gate — the hold is still the
              sole trigger; this just tells the human WHY nothing signed and how to finish. */}
          {releasedEarly ? (
            <p
              className="publish-sheet-sign-early m-0 text-sm text-sheet-soft"
              role="status"
              data-testid="sign-released-early"
            >
              You let go too soon — hold until the bar fills to sign.
            </p>
          ) : null}
          <div className="publish-sheet-foot-actions flex items-center justify-between gap-3">
            {/* The paper's OTHER action (R40): back to the draft, where editing
                lives. The paper itself is sign-only. */}
            <button
              type="button"
              className="publish-sheet-back inline-flex items-center gap-2 h-8 px-4 rounded-control border border-sheet-line text-sm font-semibold text-sheet-soft hover:bg-sheet-line"
              onClick={() => onBack?.()}
            >
              <Icon icon={ArrowLeft} className="size-3.5" /> Back to the draft
            </button>
            <button
              type="button"
              className={`publish-sheet-sign relative overflow-hidden inline-flex items-center gap-2 h-9 px-5 rounded-control text-sm font-bold bg-accent-fill text-accent-ink disabled:bg-transparent disabled:text-sheet-soft disabled:border disabled:border-sheet-line disabled:cursor-not-allowed${armed ? " is-arming" : ""}${holding ? " is-holding" : ""}`}
              data-hold-ms={holdToSignMs}
              // Both pointer AND keyboard now complete a real HOLD (issue #21): a
              // keyboard user presses and holds Enter/Space for the budget, then
              // releases. Announce the keys additively so AT knows the affordance.
              aria-keyshortcuts="Enter Space"
              // Disabled while a publish is in flight (double-sign race): the sync ref
              // in `publishReview` is the real guard; this reflects it in the UI.
              disabled={signDisabled}
              onMouseDown={beginHold}
              onMouseUp={endHold}
              onMouseLeave={clearHold}
              onKeyDown={beginHoldByKeyboard}
              onKeyUp={endHoldByKeyboard}
              onBlur={clearHold}
            >
              {/* The hold-progress fill (critique P1-C): an ink bar that inks in 0→100%
                  over EXACTLY `holdToSignMs` (duration set inline off the same prop), so
                  the hold budget is visible instead of invisible. Rendered PERSISTENTLY —
                  the `.is-holding` class on the button arms the animation, and the layout
                  effect stamps the eligibility epoch on that same commit, so visual 100%
                  and sign eligibility coincide. Reduced motion turns the continuous slide
                  into a discrete step fill (see index.css). */}
              <span
                className="publish-sheet-sign-fill absolute left-0 bottom-0 h-[3px] w-0 bg-current pointer-events-none"
                style={{ animationDuration: `${Math.max(0, holdToSignMs)}ms` }}
                aria-hidden="true"
                data-testid="sign-hold-fill"
              />
              <span className="publish-sheet-sign-label relative z-[1] inline-flex items-center gap-2">
                Hold to {variant.signLabel.toLowerCase()}
              </span>
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
    <ol
      className="publish-sheet-items list-none m-0 p-0 flex flex-col gap-2 overflow-y-auto"
      aria-label="Outbound artifact"
    >
      {items.map((entry) => {
        const occurrence = seenByPath.get(entry.path) ?? 0;
        seenByPath.set(entry.path, occurrence + 1);
        return (
          <li
            className="publish-sheet-item grid grid-cols-[auto_1fr] items-center gap-3 px-3 py-2 rounded-control border border-sheet-line"
            data-path={entry.path}
            key={`${entry.path}#${occurrence}`}
          >
            <span
              className="publish-sheet-item-type text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-chip text-sheet-soft border border-sheet-line"
              data-type={entry.type}
            >
              {entry.type}
            </span>
            <span className="publish-sheet-item-path font-mono text-sm text-sheet-ink">
              {entry.path}
            </span>
            <span className="publish-sheet-item-body col-[2/-1] text-sm font-serif text-sheet-soft">
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
    <div
      className="publish-sheet-pr flex flex-col gap-2.5 p-3.5 rounded-surface border border-sheet-line"
      data-testid="pr-submission"
    >
      <div className="publish-sheet-pr-head flex items-baseline gap-2.5">
        <span
          className={`publish-sheet-pr-state flex-none text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-chip ${
            submission.draft
              ? "border border-sheet-line text-sheet-soft"
              : "bg-accent-fill text-accent-ink"
          }`}
          data-draft={submission.draft}
        >
          {submission.draft ? "Draft" : "Ready"}
        </span>
        <h3 className="publish-sheet-pr-title m-0 text-lg font-semibold font-serif text-sheet-ink">
          {submission.title}
        </h3>
      </div>
      <p
        className="publish-sheet-pr-branches inline-flex items-center gap-1.5 m-0 text-sm text-sheet-soft"
        data-testid="pr-branches"
      >
        <code className="publish-sheet-pr-base font-mono text-sheet-ink">{submission.base}</code>
        <Icon icon={ArrowLeft} className="size-3" />
        <code className="publish-sheet-pr-head-ref font-mono text-sheet-ink">
          {submission.head}
        </code>
      </p>
      <div
        className="publish-sheet-pr-body m-0 max-h-[180px] overflow-auto p-2.5 rounded-control border border-dashed border-sheet-line text-sm leading-relaxed text-sheet-ink break-words"
        data-testid="pr-body"
      >
        {submission.body.trim() === "" ? (
          <span className="font-serif">(no description)</span>
        ) : (
          <Prose>{submission.body}</Prose>
        )}
      </div>
      <p className="publish-sheet-pr-note m-0 text-xs text-sheet-soft" role="note">
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
    <ol
      className="publish-sheet-comments list-none m-0 p-0 flex flex-col gap-2 overflow-y-auto"
      aria-label="Review comments to post"
    >
      {comments.map((comment) => {
        const occurrence = seenByPath.get(comment.path) ?? 0;
        seenByPath.set(comment.path, occurrence + 1);
        const anchorLabel =
          comment.line !== undefined ? `${comment.path}:${comment.line}` : `${comment.path}`;
        return (
          <li
            className="publish-sheet-comment grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 rounded-control border border-sheet-line"
            data-path={comment.path}
            data-line={comment.line ?? "file"}
            data-side={comment.side}
            key={`${comment.path}#${occurrence}`}
          >
            <span
              className="publish-sheet-item-type text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-chip text-sheet-soft border border-sheet-line"
              data-type={comment.type}
            >
              {comment.type}
            </span>
            <span className="publish-sheet-comment-anchor font-mono text-sm text-sheet-ink">
              {anchorLabel}
              {comment.line === undefined ? (
                <span className="publish-sheet-comment-file text-xs text-sheet-soft"> (file)</span>
              ) : (
                <span className="publish-sheet-comment-side text-xs text-sheet-soft">
                  {" "}
                  {comment.side}
                </span>
              )}
            </span>
            {comment.refined ? null : (
              <span
                className="publish-sheet-comment-raw justify-self-end text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-micro text-sheet-soft border border-sheet-line"
                data-testid="comment-raw"
                title="Raw — the refined form lands with #19"
              >
                raw
              </span>
            )}
            <span className="publish-sheet-item-body col-[1/-1] text-sm font-serif text-sheet-soft">
              {comment.body.trim() === "" ? "(no note)" : comment.body}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
