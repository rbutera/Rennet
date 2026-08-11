import type { DispositionType } from "@rennet/types";
import {
  type CollationDraft,
  type CollationItem,
  collationItems,
  mergeItems,
  moveItem,
  retypeItem,
  rewordItem,
  splitItem,
  withdrawItem,
} from "../canvas/collation";
import type { DestinationVariant } from "../canvas/destination";
import {
  isStageable,
  itemLane,
  laneCounts,
  publishReviewLabel,
  publishReviewType,
  stageItem,
} from "../canvas/staging";

// ─────────────────────────────────────────────────────────────────────────────
// The COLLATION DRAFT CANVAS (issue #101; ruling R40) — the forming destination.
//
// The missing middle layer #99 named: a canvas of its own between the lenses
// (staging) and the paper (the sign). Every disposition from every lens collates
// HERE into one coherent, still-modifiable working draft — the first time the whole
// account is one object. It is GLASS (translucent working state, yours), never
// paper: it themes for free with the two schemes and needs no material tokens of
// its own. Signing is the phase transition that freezes it into the paper.
//
// It reuses the real glass tokens (Design Doctrine; tokens.css) via the shared
// `.rennet-glass` / `.canvas-app` token scope — no parallel palette. Editing lives
// here (reword / retype / reorder / merge / split / withdraw); the paper's only
// actions are sign + back.
//
// Mode-framed (mirrors `DestinationVariant`, R40 §3): own-branch leans
// composition-heavy (the home of #72 handoff composition); other-PR leans per-item
// refinement (the home of #19 comment refinement). Same canvas, same machinery.
// #19/#72 DEEP mechanics (the live refiner, the orchestrator's real proposals) are
// follow-up beads; their seams are present and honest here.
//
// The `layer:ui` boundary allows only `@rennet/types` + this package.
// ─────────────────────────────────────────────────────────────────────────────

const TYPES: DispositionType[] = ["approve", "request-change", "comment", "question"];

/** The mode-specific line naming what editing earns its place on this draft. */
const EDIT_FRAMING: Record<DestinationVariant["mode"], string> = {
  "own-branch":
    "Compose your dispositions into one coherent handoff — merge, reorder, and reword them into a single set of asks.",
  "other-pr":
    "Refine each comment into the review you'll post — reword, group related ones, and drop the ones you've decided against.",
};

/**
 * The EPHEMERAL per-item refinement state (issue #19) the host tracks while a
 * refine turn is in flight or after a non-adopting outcome. The ADOPTED state is
 * durable on the item itself (`item.refined`), so it is NOT here — this map holds
 * only the transient/honest-failure states. Absent entry + no `item.refined` ⇒
 * idle (offer a Refine button).
 */
export type RefineItemState =
  | { readonly status: "refining" }
  | { readonly status: "no-change" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** A raw note is refinable when it has actual text (an empty item cannot be cleaned). */
function isRefinable(item: CollationItem): boolean {
  return item.raw.trim() !== "";
}

export function CollationDraftCanvas({
  draft,
  variant,
  onChange,
  onSign,
  onBack,
  onRefine,
  onKeepRaw,
  onRefineAll,
  refineStates,
}: {
  /** The editable collation draft — the L2 disposition set across every angle. */
  draft: CollationDraft;
  /** The mode framing (own-branch composition / other-PR refinement). */
  variant: DestinationVariant;
  /** Every edit is a pure transform of the draft; the host owns the state. */
  onChange: (next: CollationDraft) => void;
  /** Sign: freeze this glass draft into the paper (the phase transition). */
  onSign?: () => void;
  /** Back to the lenses — the draft is not lost, it stays yours. */
  onBack?: () => void;
  /**
   * Refine ONE item's raw note into a clean comment (#19). The host runs the real
   * model turn and rounds the result back onto the draft. Absent ⇒ no refine
   * affordance renders (a composition without the producer wired).
   */
  onRefine?: (item: CollationItem) => void;
  /** Keep the original raw note, dropping a landed refinement (#19 — the undo). */
  onKeepRaw?: (item: CollationItem) => void;
  /** Refine every refinable, not-yet-refined item in one act ("Refine to post"). */
  onRefineAll?: () => void;
  /** The ephemeral per-item refine state, keyed by item id (idle when absent). */
  refineStates?: Readonly<Record<string, RefineItemState>>;
}) {
  const items = collationItems(draft);
  const empty = draft.length === 0;
  // The ink/blue split + the sign-off roll-up (issue #109). Ink travels to the PR;
  // blue stays on this machine. The roll-up is the PR review type over the ink
  // subset only (request-changes / comments / nothing) — approve never appears.
  const lanes = laneCounts(draft);
  const rollup = publishReviewType(draft);
  // The bulk "Refine to post" affordance is live when the producer is wired and at
  // least one item is refinable, not already refined, and not mid-flight.
  const anyRefinable =
    onRefineAll !== undefined &&
    draft.some(
      (item) =>
        isRefinable(item) &&
        item.refined === undefined &&
        refineStates?.[item.id]?.status !== "refining",
    );

  return (
    <div
      className="collation-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Collation draft"
    >
      <section className="collation-canvas" data-mode={variant.mode}>
        <header className="collation-head">
          <div>
            <p className="collation-eyebrow">THE COLLATION DRAFT</p>
            <h2 className="collation-title">{variant.title}</h2>
            <p className="collation-framing">{EDIT_FRAMING[variant.mode]}</p>
          </div>
          <div className="collation-head-actions">
            <span className="collation-count">
              <strong>{draft.length}</strong> collated
            </span>
            {onRefineAll ? (
              <button
                type="button"
                className="collation-refine-all"
                onClick={() => onRefineAll()}
                disabled={!anyRefinable}
                aria-label="Refine all notes to post"
                title="Clean every rough note into a well-phrased comment — your originals are kept"
              >
                ✦ Refine to post
              </button>
            ) : null}
            <button
              type="button"
              className="collation-back"
              onClick={() => onBack?.()}
              aria-label="Back to the lenses"
            >
              ← Lenses
            </button>
          </div>
        </header>

        {/* The orchestrator-on-tap seam (§2.3 L2/L3): you may ASK about the forming
            draft; the orchestrator PROPOSES on L3 and you accept into L2 — it never
            writes the draft itself (the safety line holds). Wiring the real
            orchestrator is a follow-up; the affordance is present and honest. */}
        <div className="collation-ask" role="note">
          <span className="collation-ask-glyph" aria-hidden="true">
            ◇
          </span>
          <span>
            Ask the orchestrator about this draft — it proposes; you accept. (The live orchestrator
            lands with #15/#19.)
          </span>
        </div>

        {empty ? (
          <p className="collation-empty">
            The draft is empty. Dispose something on a lens and it collates here — still yours,
            until you sign.
          </p>
        ) : (
          <ol className="collation-items" aria-label="Collated dispositions">
            {draft.map((item, index) => {
              const lane = itemLane(item);
              const stageable = isStageable(item.type);
              // The refine state (#19): a durable adopted refinement lives on the
              // item; the ephemeral in-flight/failed states come from the host map.
              const refineState = refineStates?.[item.id];
              const refined = item.refined !== undefined;
              const refinable = isRefinable(item);
              return (
                <li
                  className="collation-item"
                  data-item-id={item.id}
                  data-path={item.path}
                  data-type={item.type}
                  data-lane={lane}
                  key={item.id}
                >
                  <div className="collation-item-top">
                    <span className="collation-item-ordinal" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="collation-item-path" title={item.path}>
                      {item.path}
                    </span>
                    <select
                      className="collation-item-type"
                      aria-label={`Type for item ${index + 1}`}
                      value={item.type}
                      onChange={(event) =>
                        onChange(retypeItem(draft, item.id, event.target.value as DispositionType))
                      }
                    >
                      {TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    {/* The material law, visible per item (issue #109): ink travels
                        to the PR; blue stays on this machine. */}
                    <span
                      className="collation-item-lane"
                      data-lane={lane}
                      title={
                        lane === "ink"
                          ? "Ink — this travels to the pull request"
                          : "Blue — private to this machine, never published"
                      }
                    >
                      {lane === "ink" ? "Publishes" : "Local"}
                    </span>
                  </div>

                  {/* The stage / keep-local toggle (issue #109). Only comment and
                      question are stageable — they default to the orchestrator (blue)
                      and travel to the PR (ink) only when staged. Approve never
                      publishes and request-change always does, so neither shows a
                      toggle: their lane is not the reviewer's to move. */}
                  {stageable ? (
                    <label className="collation-item-stage">
                      <input
                        type="checkbox"
                        className="collation-item-stage-box"
                        aria-label={`Stage item ${index + 1} to the pull request`}
                        checked={lane === "ink"}
                        onChange={(event) =>
                          onChange(stageItem(draft, item.id, event.target.checked))
                        }
                      />
                      <span>
                        {lane === "ink"
                          ? "Staged to the PR — uncheck to keep it with the orchestrator"
                          : "With the orchestrator — check to stage it onto the PR"}
                      </span>
                    </label>
                  ) : null}

                  {/* The sovereign raw note is ALWAYS what you edit (#19 / R40):
                      the textarea binds to `raw`, so a landed refinement never
                      hijacks the field you type in, and editing it invalidates a
                      stale refinement (rewordItem clears `refined`, #236). */}
                  <textarea
                    className="collation-item-body"
                    aria-label={`Body for item ${index + 1}`}
                    value={item.raw}
                    placeholder="Rough note — lazy is fine; refine it into a clean comment."
                    onChange={(event) => onChange(rewordItem(draft, item.id, event.target.value))}
                  />

                  {/* The comment-refinement loop (#19), rendered per state. A landed
                      refinement is an OFFER (keep-my-original always available), a
                      failed/unavailable turn is stated PLAINLY and the raw still
                      posts — the loop failing is worse prose, never a silent rewrite
                      and never a spinner masking absence. */}
                  <div
                    className="collation-item-refine"
                    data-refine-state={refineState?.status ?? (refined ? "refined" : "idle")}
                  >
                    {refined ? (
                      <div className="collation-refined" role="note">
                        <p className="collation-refined-label">
                          Refined — this posts instead of your note
                        </p>
                        <p className="collation-refined-body">{item.refined}</p>
                        {onKeepRaw ? (
                          <button
                            type="button"
                            className="collation-keep-raw"
                            aria-label={`Keep my original note for item ${index + 1}`}
                            onClick={() => onKeepRaw(item)}
                          >
                            Keep my original
                          </button>
                        ) : null}
                      </div>
                    ) : refineState?.status === "refining" ? (
                      <p className="collation-refine-pending" aria-live="polite">
                        Refining your note…
                      </p>
                    ) : refineState?.status === "failed" ? (
                      <p className="collation-refine-failed" role="alert">
                        Couldn't refine this note: {refineState.reason}. Your original will post.
                        {onRefine ? (
                          <button
                            type="button"
                            className="collation-refine-retry"
                            aria-label={`Retry refining item ${index + 1}`}
                            onClick={() => onRefine(item)}
                          >
                            Retry
                          </button>
                        ) : null}
                      </p>
                    ) : refineState?.status === "unavailable" ? (
                      <p className="collation-refine-unavailable" role="note">
                        {refineState.reason}. Your original will post.
                      </p>
                    ) : refineState?.status === "no-change" ? (
                      <p className="collation-refine-nochange" role="note">
                        Already clear — nothing to refine. Your note posts as written.
                      </p>
                    ) : onRefine && refinable ? (
                      <button
                        type="button"
                        className="collation-refine"
                        aria-label={`Refine item ${index + 1}`}
                        onClick={() => onRefine(item)}
                      >
                        ✦ Refine to post
                      </button>
                    ) : (
                      <p className="collation-refine-raw" role="note">
                        Posts as your note, unchanged.
                      </p>
                    )}
                  </div>

                  <div className="collation-item-actions">
                    <button
                      type="button"
                      className="collation-act collation-move-up"
                      aria-label={`Move item ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => onChange(moveItem(draft, item.id, "up"))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="collation-act collation-move-down"
                      aria-label={`Move item ${index + 1} down`}
                      disabled={index === draft.length - 1}
                      onClick={() => onChange(moveItem(draft, item.id, "down"))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="collation-act collation-merge"
                      aria-label={`Merge item ${index + 1} with the next`}
                      disabled={index === draft.length - 1}
                      onClick={() => {
                        const next = draft[index + 1];
                        if (next) onChange(mergeItems(draft, item.id, next.id));
                      }}
                    >
                      Merge ↓
                    </button>
                    <button
                      type="button"
                      className="collation-act collation-split"
                      aria-label={`Split item ${index + 1} into two`}
                      onClick={() => onChange(splitItem(draft, item.id))}
                    >
                      Split
                    </button>
                    <button
                      type="button"
                      className="collation-act collation-withdraw"
                      aria-label={`Withdraw item ${index + 1}`}
                      onClick={() => onChange(withdrawItem(draft, item.id))}
                    >
                      Withdraw
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {/* The totality/residue guarantee is reachable at all times (Design
            Doctrine §3.2): sign still blocks on incomplete ingestion. This slice
            runs on fixtures, so it states the guarantee honestly rather than
            fabricating a coverage number. */}
        <p className="collation-residue" role="note">
          Everything you've staged is here. Sign still blocks on anything not yet ingested — the
          whole account, or nothing.
        </p>

        {/* The sign-off roll-up (issue #109): the PR review type over the INK subset
            only. Approve never appears; request-changes drives the type; a staged
            comment/question rolls up to a plain comments review; else nothing
            publishes. The lane counts state what travels vs what stays local. */}
        <div className="collation-rollup" role="note" data-rollup={rollup ?? "none"}>
          <p className="collation-rollup-line">
            <span className="collation-rollup-label">Posts as</span>
            <span className="collation-rollup-verdict" data-verdict={rollup ?? "none"}>
              {publishReviewLabel(rollup)}
            </span>
          </p>
          <p className="collation-rollup-lanes">
            <span className="collation-lane-count" data-lane="ink">
              <strong>{lanes.ink}</strong> travel to the PR
            </span>
            <span className="collation-lane-sep" aria-hidden="true">
              ·
            </span>
            <span className="collation-lane-count" data-lane="blue">
              <strong>{lanes.blue}</strong> stay on this machine
            </span>
          </p>
        </div>

        <footer className="collation-foot">
          <p className="collation-foot-note">
            {items.length === 0
              ? "Nothing collated yet."
              : `${items.length} disposition${items.length === 1 ? "" : "s"}, still glass. Sign to freeze into paper.`}
          </p>
          <button
            type="button"
            className="collation-sign"
            disabled={empty}
            onClick={() => onSign?.()}
          >
            Sign the draft →
          </button>
        </footer>
      </section>
    </div>
  );
}
