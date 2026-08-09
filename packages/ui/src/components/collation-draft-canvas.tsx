import {
  type CollationDraft,
  collationItems,
  effectiveBody,
  mergeItems,
  moveItem,
  retypeItem,
  rewordItem,
  splitItem,
  withdrawItem,
} from "../canvas/collation";
import type { DestinationVariant } from "../canvas/destination";
import { deriveReviewEvent, type ForgeReviewEvent, reviewComments } from "../canvas/publish";
import { DispositionBar } from "./disposition";
import { CheckIcon, CommentIcon, TriangleIcon } from "./icons";

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

/**
 * How the live roll-up reads, per mode, for each verdict the draft derives. The
 * verdict comes from `deriveReviewEvent` (the twin the sign wire posts), so what
 * this readout shows is exactly what signing produces — "what you see is what
 * leaves" (R33). request-change on ANY line escalates the whole review (issue #109:
 * "if there is >= 1 request-changes block, the WHOLE PR review becomes request
 * changes").
 */
const VERDICT_READOUT: Record<
  ForgeReviewEvent,
  {
    label: string;
    className: string;
    Icon: typeof CheckIcon;
    note: Record<DestinationVariant["mode"], string>;
  }
> = {
  REQUEST_CHANGES: {
    label: "Request changes",
    className: "is-request",
    Icon: TriangleIcon,
    note: {
      "own-branch": "A line requests changes — your agent is asked to go fix it before this lands.",
      "other-pr": "A line requests changes — the whole review posts as REQUEST CHANGES.",
    },
  },
  APPROVE: {
    label: "Approve",
    className: "is-approve",
    Icon: CheckIcon,
    note: {
      "own-branch": "Nothing to change — every line is approved.",
      "other-pr": "Every line is approved.",
    },
  },
  COMMENT: {
    label: "Comments",
    className: "is-comment",
    Icon: CommentIcon,
    note: {
      "own-branch": "Comments and questions for your agent — nothing is blocking.",
      "other-pr": "No changes requested — the review posts as COMMENT.",
    },
  },
};

/** The verdict the current draft derives — the value the sign wire will post. */
function draftVerdict(draft: CollationDraft): ForgeReviewEvent {
  return deriveReviewEvent(reviewComments(draft));
}

/** The mode-specific line naming what editing earns its place on this draft. */
const EDIT_FRAMING: Record<DestinationVariant["mode"], string> = {
  "own-branch":
    "Compose your dispositions into one coherent handoff — merge, reorder, and reword them into a single set of asks.",
  "other-pr":
    "Refine each comment into the review you'll post — reword, group related ones, and drop the ones you've decided against.",
};

export function CollationDraftCanvas({
  draft,
  variant,
  onChange,
  onSign,
  onBack,
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
}) {
  const items = collationItems(draft);
  const empty = draft.length === 0;
  // The live roll-up: the verdict the current per-line choices derive, which is the
  // exact value the sign wire posts (deriveReviewEvent). Shown so the connection
  // between a per-line "request change" and the whole review's verdict is visible as
  // you work (issue #109), not a surprise at the sign.
  const verdict = draftVerdict(draft);
  const verdictReadout = VERDICT_READOUT[verdict];

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
              const refining = item.refined === undefined;
              return (
                <li
                  className="collation-item"
                  data-item-id={item.id}
                  data-path={item.path}
                  data-type={item.type}
                  key={item.id}
                >
                  <div className="collation-item-top">
                    <span className="collation-item-ordinal" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="collation-item-path" title={item.path}>
                      {item.path}
                    </span>
                  </div>

                  {/* The per-line verdict control (issue #109): approve / request
                      change / comment / question on THIS block, as real icon
                      buttons (not a dropdown), the current one pressed. Setting it
                      retypes the item in the draft, so the collated draft, the
                      derived verdict, and the sign all reflect the choice — a real
                      round-trip into the draft, not a cosmetic toggle. */}
                  <DispositionBar
                    scopeLabel={`item ${index + 1} (${item.path})`}
                    compact
                    active={item.type}
                    onDisposition={(type) => onChange(retypeItem(draft, item.id, type))}
                  />

                  <textarea
                    className="collation-item-body"
                    aria-label={`Body for item ${index + 1}`}
                    value={effectiveBody(item)}
                    placeholder="Raw note — lazy is fine; the refiner cleans it up."
                    onChange={(event) => onChange(rewordItem(draft, item.id, event.target.value))}
                  />

                  {/* The §2.5 refiner seam: the cleaned form arrives in the
                      background. Until the loop is wired (#19), the raw is the
                      effective body and this states so honestly — never a spinner. */}
                  <p className="collation-item-refine" data-refining={refining}>
                    {refining ? "Raw — the refiner will clean this in the background." : "Refined."}
                  </p>

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

        {/* The live verdict roll-up (issue #109): what the current per-line choices
            will post. request-change on any line ⇒ the whole review requests
            changes. Derived from the SAME `deriveReviewEvent` the sign wire posts. */}
        {empty ? null : (
          <div
            className={`collation-verdict ${verdictReadout.className}`}
            role="status"
            data-verdict={verdict}
          >
            <verdictReadout.Icon size={15} />
            <span className="collation-verdict-label">
              This review will <strong>{verdictReadout.label}</strong>
            </span>
            <span className="collation-verdict-note">{verdictReadout.note[variant.mode]}</span>
          </div>
        )}

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
