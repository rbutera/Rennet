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
import { ArrowLeftIcon, ArrowRightIcon } from "./icons";

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
// It reuses the real glass tokens (Design Doctrine; @rennet/theme) via the shared
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

/** The mode-specific line naming what editing earns its place on this draft. Terse
 *  chrome (§4 four-word rule): the item controls show the affordances, so the frame
 *  names the destination, not a how-to sentence. */
const EDIT_FRAMING: Record<DestinationVariant["mode"], string> = {
  "own-branch": "Compose the handoff.",
  "other-pr": "Refine the review.",
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

/**
 * The EPHEMERAL PR-body drafting state (issue #74, M26), tracked by the host while a
 * drafting turn is in flight or after its outcome. The DRAFTED title+body are durable
 * in the host's `prDraft` state (the editable fields), so they are NOT here — this
 * carries only the transient/outcome status the composer shows beside the fields.
 * Absent ⇒ idle (offer the "Draft with AI" affordance).
 */
export type PrDraftState =
  | { readonly status: "drafting" }
  | { readonly status: "drafted"; readonly model: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** The editable PR submission the own-branch composer holds (issue #74). */
export interface PrDraftValues {
  readonly title: string;
  readonly body: string;
}

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
  prDraft,
  onPrDraftChange,
  onDraftPrBody,
  prDraftState,
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
  /**
   * The editable PR submission draft (issue #74, M26) — own-branch composition only.
   * The composer renders `prDraft.title`/`prDraft.body` as editable fields and rounds
   * every keystroke back through `onPrDraftChange`. Absent ⇒ no composer renders (the
   * other-PR mode, or a host that does not carry it).
   */
  prDraft?: PrDraftValues;
  /** A PR-draft field was edited — the host owns the state (the human's edit is final). */
  onPrDraftChange?: (next: PrDraftValues) => void;
  /**
   * Draft the PR title + body with the model (#74). The host runs the real council-
   * routed turn and rounds the result into `prDraft`. Absent ⇒ no "Draft with AI"
   * affordance renders (a composition without the producer wired) — the fields stay
   * editable and the deterministic body still previews on the paper.
   */
  onDraftPrBody?: () => void;
  /** The ephemeral PR-draft status (idle when absent). */
  prDraftState?: PrDraftState;
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
      className="collation-backdrop fixed inset-0 z-[38] grid place-items-center bg-black/60 p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Collation draft"
    >
      <section
        className="collation-canvas flex max-h-[calc(100vh-64px)] w-[min(760px,100%)] flex-col gap-4 rounded-window border border-line bg-overlay p-6 font-sans text-ink shadow-overlay"
        data-mode={variant.mode}
      >
        <header className="collation-head flex items-start justify-between gap-4">
          <div>
            <p className="collation-eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              THE COLLATION DRAFT
            </p>
            <h2 className="collation-title mt-1 font-display text-xl font-semibold text-ink">
              {variant.title}
            </h2>
            <p className="collation-framing mt-1.5 max-w-[46ch] text-sm leading-snug text-ink-soft">
              {EDIT_FRAMING[variant.mode]}
            </p>
          </div>
          <div className="collation-head-actions flex flex-col items-end gap-2">
            <span className="collation-count text-sm text-ink-soft">
              <strong className="text-xl font-semibold text-accent">{draft.length}</strong> collated
            </span>
            {onRefineAll ? (
              <button
                type="button"
                className="collation-refine-all h-8 rounded-control bg-accent-fill px-3 text-sm font-semibold text-accent-ink disabled:opacity-40"
                onClick={() => onRefineAll()}
                disabled={!anyRefinable}
                aria-label="Refine all notes"
                title="Refine every note"
              >
                Refine to post
              </button>
            ) : null}
            <button
              type="button"
              className="collation-back inline-flex h-8 items-center gap-1.5 rounded-control border border-line px-3 text-sm text-ink-soft hover:bg-raised"
              onClick={() => onBack?.()}
              aria-label="Back to the lenses"
            >
              <ArrowLeftIcon size={12} /> Lenses
            </button>
          </div>
        </header>

        {/* The orchestrator-on-tap seam (§2.3 L2/L3): you may ASK about the forming
            draft; the orchestrator PROPOSES on L3 and you accept into L2 — it never
            writes the draft itself (the safety line holds). Wiring the real
            orchestrator is a follow-up; the affordance is present and honest. */}
        <div
          className="collation-ask flex items-center gap-2 rounded-control border border-accent-line bg-accent-surface px-3 py-2 text-sm text-ink-soft"
          role="note"
        >
          <span className="collation-ask-glyph text-sm text-accent" aria-hidden="true">
            ◇
          </span>
          <span>
            Ask the orchestrator about this draft — it proposes; you accept. (The live orchestrator
            lands with #15/#19.)
          </span>
        </div>

        {/* The PR-submission composer (issue #74, M26) — own-branch composition only.
            Rennet drafts an honest title + body from the reviewed changeset; the
            fields are editable and the human's edit is final. This is a DRAFT into a
            preview: nothing is pushed here (creating the PR is the gated #21 act). */}
        {variant.mode === "own-branch" && prDraft !== undefined ? (
          <div
            className="collation-pr-draft flex flex-col gap-2 rounded-control border border-accent-line bg-accent-surface p-3"
            data-testid="pr-draft-composer"
          >
            <div className="collation-pr-draft-head flex items-center justify-between gap-2">
              <p className="collation-pr-draft-label m-0 text-2xs font-semibold uppercase tracking-wide text-ink-soft">
                PR submission
              </p>
              {onDraftPrBody ? (
                <button
                  type="button"
                  className="collation-pr-draft-btn h-8 rounded-control border border-accent-line px-3 text-sm text-accent hover:bg-accent-soft disabled:opacity-60"
                  onClick={() => onDraftPrBody()}
                  disabled={prDraftState?.status === "drafting"}
                  aria-label="Draft the PR title and description with AI"
                  title="Draft the PR title and body from your review"
                >
                  {prDraftState?.status === "drafting" ? "Drafting…" : "Draft with AI"}
                </button>
              ) : null}
            </div>
            <label className="collation-pr-draft-field flex flex-col gap-1">
              <span className="collation-pr-draft-field-label text-xs text-ink-faint">Title</span>
              <input
                type="text"
                className="collation-pr-draft-title h-8 w-full rounded-control border border-line bg-surface px-2.5 text-base text-ink"
                data-testid="pr-draft-title"
                value={prDraft.title}
                placeholder="A concise PR title"
                onChange={(event) => onPrDraftChange?.({ ...prDraft, title: event.target.value })}
              />
            </label>
            <label className="collation-pr-draft-field flex flex-col gap-1">
              <span className="collation-pr-draft-field-label text-xs text-ink-faint">
                Description
              </span>
              <textarea
                className="collation-pr-draft-body w-full resize-y rounded-control border border-line bg-surface px-2.5 py-2 text-base leading-relaxed text-ink"
                data-testid="pr-draft-body"
                value={prDraft.body}
                rows={6}
                placeholder="An honest account of the change — Rennet can draft this from your review."
                onChange={(event) => onPrDraftChange?.({ ...prDraft, body: event.target.value })}
              />
            </label>
            {prDraftState?.status === "drafted" ? (
              <p
                className="collation-pr-draft-status m-0 text-sm text-ink-soft"
                data-testid="pr-draft-status"
                role="note"
              >
                Drafted with {prDraftState.model}. Edit freely — your version is what the PR would
                use.
              </p>
            ) : prDraftState?.status === "unavailable" ? (
              <p
                className="collation-pr-draft-status m-0 text-sm text-ink-soft"
                data-testid="pr-draft-status"
                data-status="unavailable"
                role="note"
              >
                No model seat is installed to draft with, so the description falls back to your
                dispositions. {prDraftState.reason}
              </p>
            ) : prDraftState?.status === "failed" ? (
              <p
                className="collation-pr-draft-status m-0 text-sm text-danger"
                data-testid="pr-draft-status"
                data-status="failed"
                role="alert"
              >
                The draft didn't land: {prDraftState.reason}. Your text is untouched — write or
                retry.
              </p>
            ) : null}
          </div>
        ) : null}

        {empty ? (
          <p className="collation-empty m-0 px-2 py-7 text-center text-base leading-relaxed text-ink-faint">
            The draft is empty. Dispose something on a lens and it collates here — still yours,
            until you sign.
          </p>
        ) : (
          <ol
            className="collation-items m-0 flex list-none flex-col gap-3 overflow-y-auto p-0"
            aria-label="Collated dispositions"
          >
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
                  className="collation-item flex flex-col gap-2 rounded-surface border border-line border-l-2 bg-raised p-4 data-[lane=blue]:border-l-accent-line data-[lane=ink]:border-l-line-strong"
                  data-item-id={item.id}
                  data-path={item.path}
                  data-type={item.type}
                  data-lane={lane}
                  key={item.id}
                >
                  <div className="collation-item-top flex items-center gap-2.5">
                    <span
                      className="collation-item-ordinal grid size-[22px] shrink-0 place-items-center rounded-chip bg-accent-fill text-xs font-bold text-accent-ink"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <span
                      className="collation-item-path min-w-0 flex-1 truncate font-mono text-sm text-ink"
                      title={item.path}
                    >
                      {item.path}
                    </span>
                    <select
                      className="collation-item-type h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink"
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
                      className={`collation-item-lane shrink-0 rounded-chip border px-2 py-0.5 text-2xs font-bold uppercase tracking-wide ${
                        lane === "ink"
                          ? "border-line-strong bg-raised text-ink"
                          : "border-accent-line bg-accent-soft text-accent"
                      }`}
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
                    <label className="collation-item-stage mt-1.5 flex items-center gap-2 text-sm text-ink-soft">
                      <input
                        type="checkbox"
                        className="collation-item-stage-box shrink-0 accent-accent-fill"
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
                    className="collation-item-body min-h-[52px] w-full resize-y rounded-control border border-line bg-code px-2.5 py-2 text-base leading-relaxed text-ink"
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
                    className="collation-item-refine text-xs"
                    data-refine-state={refineState?.status ?? (refined ? "refined" : "idle")}
                  >
                    {/* Terse chrome labels (§4); the model/system reason and the
                        refined body are CONTENT and breathe. The raw textarea above
                        stays visible, so "your original posts" holds structurally
                        without a chrome sentence saying so. */}
                    {refined ? (
                      <div
                        className="collation-refined rounded-control border border-green-line bg-green-soft px-2.5 py-2"
                        role="note"
                      >
                        <p className="collation-refined-label m-0 text-2xs font-bold uppercase tracking-wide text-ink">
                          Refined
                        </p>
                        <p className="collation-refined-body mt-1 text-base leading-relaxed text-ink">
                          {item.refined}
                        </p>
                        {onKeepRaw ? (
                          <button
                            type="button"
                            className="collation-keep-raw mt-1.5 cursor-pointer bg-transparent p-0 text-xs text-ink-soft underline"
                            aria-label={`Keep original note for item ${index + 1}`}
                            onClick={() => onKeepRaw(item)}
                          >
                            Keep original
                          </button>
                        ) : null}
                      </div>
                    ) : refineState?.status === "refining" ? (
                      <p
                        className="collation-refine-pending m-0 italic text-accent"
                        aria-live="polite"
                      >
                        Refining…
                      </p>
                    ) : refineState?.status === "failed" ? (
                      <p
                        className="collation-refine-failed m-0 flex flex-wrap items-baseline gap-1.5"
                        role="alert"
                      >
                        <span className="collation-refine-chrome font-semibold text-danger">
                          Refine failed
                        </span>
                        <span className="collation-refine-reason text-ink-faint">
                          {refineState.reason}
                        </span>
                        {onRefine ? (
                          <button
                            type="button"
                            className="collation-refine-retry ml-2 rounded-control border border-accent-line px-2 py-0.5 text-xs font-semibold text-accent hover:bg-accent-soft"
                            aria-label={`Retry refining item ${index + 1}`}
                            onClick={() => onRefine(item)}
                          >
                            Retry
                          </button>
                        ) : null}
                      </p>
                    ) : refineState?.status === "unavailable" ? (
                      <p
                        className="collation-refine-unavailable m-0 flex flex-wrap items-baseline gap-1.5"
                        role="note"
                      >
                        <span className="collation-refine-chrome font-semibold text-ink-soft">
                          Refine unavailable
                        </span>
                        <span className="collation-refine-reason text-ink-faint">
                          {refineState.reason}
                        </span>
                      </p>
                    ) : refineState?.status === "no-change" ? (
                      <p className="collation-refine-nochange m-0 text-green" role="note">
                        Already clear
                      </p>
                    ) : onRefine && refinable ? (
                      <button
                        type="button"
                        className="collation-refine rounded-control border border-accent-line bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent-surface"
                        aria-label={`Refine item ${index + 1}`}
                        onClick={() => onRefine(item)}
                      >
                        Refine
                      </button>
                    ) : null}
                  </div>

                  <div className="collation-item-actions flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="collation-act collation-move-up rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-raised hover:text-ink disabled:opacity-40"
                      aria-label={`Move item ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => onChange(moveItem(draft, item.id, "up"))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="collation-act collation-move-down rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-raised hover:text-ink disabled:opacity-40"
                      aria-label={`Move item ${index + 1} down`}
                      disabled={index === draft.length - 1}
                      onClick={() => onChange(moveItem(draft, item.id, "down"))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="collation-act collation-merge rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-raised hover:text-ink disabled:opacity-40"
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
                      className="collation-act collation-split rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-raised hover:text-ink disabled:opacity-40"
                      aria-label={`Split item ${index + 1} into two`}
                      onClick={() => onChange(splitItem(draft, item.id))}
                    >
                      Split
                    </button>
                    <button
                      type="button"
                      className="collation-act collation-withdraw ml-auto rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-40"
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
        <p
          className="collation-residue m-0 rounded-control border border-dashed border-line-strong px-3 py-2 text-xs text-ink-soft"
          role="note"
        >
          Everything you've staged is here. Sign still blocks on anything not yet ingested — the
          whole account, or nothing.
        </p>

        {/* The sign-off roll-up (issue #109): the PR review type over the INK subset
            only. Approve never appears; request-changes drives the type; a staged
            comment/question rolls up to a plain comments review; else nothing
            publishes. The lane counts state what travels vs what stays local. */}
        <div
          className="collation-rollup my-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 rounded-surface border border-line bg-raised px-3.5 py-2.5"
          role="note"
          data-rollup={rollup ?? "none"}
        >
          <p className="collation-rollup-line m-0 flex items-baseline gap-2">
            <span className="collation-rollup-label text-2xs font-bold uppercase tracking-wide text-ink-faint">
              Posts as
            </span>
            <span
              className="collation-rollup-verdict text-sm font-bold text-ink data-[verdict=none]:text-ink-soft"
              data-verdict={rollup ?? "none"}
            >
              {publishReviewLabel(rollup)}
            </span>
          </p>
          <p className="collation-rollup-lanes m-0 flex items-baseline gap-2 text-sm text-ink-soft">
            <span className="collation-lane-count text-ink" data-lane="ink">
              <strong>{lanes.ink}</strong> travel to the PR
            </span>
            <span className="collation-lane-sep text-ink-faint" aria-hidden="true">
              ·
            </span>
            <span className="collation-lane-count text-ink" data-lane="blue">
              <strong>{lanes.blue}</strong> stay on this machine
            </span>
          </p>
        </div>

        <footer className="collation-foot flex items-center justify-between gap-4 border-t border-line pt-1">
          <p className="collation-foot-note m-0 text-sm text-ink-soft">
            {items.length === 0
              ? "Nothing collated yet."
              : `${items.length} disposition${items.length === 1 ? "" : "s"}, still glass. Sign to freeze into paper.`}
          </p>
          <button
            type="button"
            className="collation-sign inline-flex h-10 items-center gap-2 rounded-control bg-accent-fill px-5 text-base font-semibold text-accent-ink disabled:opacity-45"
            // Disabled while a PR-body draft is in flight (#74 HIGH-2): opening the
            // paper mid-draft is the entry to the swap-during-hold hole — the model
            // result would land while the paper is open and recompose its payload.
            // Signing waits for the draft to SETTLE, so the paper freezes a stable
            // account, and no new draft can start once the paper is open.
            // Disabled while a PR-body draft is in flight (#74 HIGH-2): opening the
            // paper mid-draft is the entry to the swap-during-hold hole — the model
            // result would land while the paper is open and recompose its payload.
            // Signing waits for the draft to SETTLE, so the paper freezes a stable
            // account, and no new draft can start once the paper is open.
            disabled={empty || prDraftState?.status === "drafting"}
            onClick={() => onSign?.()}
          >
            Sign the draft <ArrowRightIcon size={14} />
          </button>
        </footer>
      </section>
    </div>
  );
}
