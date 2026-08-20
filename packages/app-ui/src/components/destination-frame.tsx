import { Button } from "@rennet/ui";
import { ArrowRight, Target } from "lucide-react";
import { type CollationDraft, collationItems } from "../canvas/collation";
import {
  type DestinationMode,
  type DestinationVariant,
  destinationVariant,
} from "../canvas/destination";
import { handoffDispositions } from "../canvas/publish";
import { laneCounts } from "../canvas/staging";
import { Icon } from "./icon";

// ─────────────────────────────────────────────────────────────────────────────
// The DESTINATION FRAME (issue #64; re-pointed by R40, issue #101) — the
// persistent north the review stages toward. Always-present chrome, top-right,
// rendered from review-open even with nothing collated (an empty forming draft).
// It names WHAT the user is staging toward (the variant by mode) and fills visibly
// as dispositions are made (dispose == staged).
//
// R40 re-point: the frame stops BEING the paper. Clicking through now opens the
// COLLATION DRAFT CANVAS (issue #101) — the editable forming destination — NOT the
// publish sheet. The flow is frame → draft → paper (two surfaces), not frame →
// paper. The empty-state copy "The paper is blank" was wrong (the frame is not the
// paper) and is now "The draft is empty."
//
// The collated DATA is identical across modes; only the framing changes. This
// component is presentational: the draft and the mode are owned by the host.
// ─────────────────────────────────────────────────────────────────────────────

const MODES: DestinationMode[] = ["own-branch", "other-pr"];

// The disposition-type badge wash (issue #109). Approve reads evidence-green;
// request-change and question share the gold register (accent and decision merged,
// 2026-08-19); comment stays neutral. Soft washes keep the letter legible in both
// schemes without an on-colour contrast trap.
const TYPE_BADGE: Record<string, string> = {
  approve: "bg-green-soft text-green",
  "request-change": "bg-accent-soft text-accent",
  question: "bg-accent-soft text-accent",
  comment: "bg-raised text-ink-faint",
};

export function DestinationFrame({
  draft,
  mode,
  onSelectMode,
  onOpenDraft,
  onHandoff,
}: {
  draft: CollationDraft;
  mode: DestinationMode;
  /** Flip the framing (own-branch handoff bundle / other-PR review). Same data. */
  onSelectMode?: (mode: DestinationMode) => void;
  /** Open the collation draft canvas (#101) — collate, edit, then sign. */
  onOpenDraft?: () => void;
  /**
   * Open the stage-6 handoff paper (#72) — compose the bundle, preview it, run it.
   * Only offered on own-branch with at least one actionable ask; absent ⇒ no button.
   */
  onHandoff?: () => void;
}) {
  const variant: DestinationVariant = destinationVariant(mode);
  const items = collationItems(draft);
  const empty = items.length === 0;
  // The handoff path is own-branch only, and only when there is something a coding
  // agent can act on (a request-change or comment). No actionable ask ⇒ no button.
  const handoffCount = handoffDispositions(draft).length;
  const canHandoff = onHandoff !== undefined && mode === "own-branch" && handoffCount > 0;
  // The ink/blue split (issue #109): how many dispositions travel to the PR vs stay
  // private on this machine (the wireframe's "N private" pill).
  const lanes = laneCounts(draft);

  return (
    <aside
      className="destination-frame fixed right-4 top-14 z-[11] hidden max-h-[calc(100vh-76px)] w-[268px] flex-col gap-3 overflow-hidden rounded-window border border-line bg-surface p-4 font-sans [[data-destination-visible]_&]:flex"
      data-mode={mode}
      data-staged-count={items.length}
      data-publish-count={lanes.ink}
      data-private-count={lanes.blue}
      aria-label={`Destination: ${variant.title}`}
    >
      <header className="destination-head">
        <p className="destination-eyebrow m-0 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          <Icon icon={Target} className="size-3" />
          STAGING TOWARD
        </p>
        <h2 className="destination-title mt-1 font-display text-lg font-semibold text-ink">
          {variant.title}
        </h2>
        <p className="destination-summary mt-1 text-sm leading-snug text-ink-soft">
          {variant.summary}
        </p>
      </header>

      {onSelectMode ? (
        <div
          className="destination-modes flex gap-1 rounded-control border border-line bg-raised p-1"
          role="tablist"
          aria-label="Destination variant"
        >
          {MODES.map((candidate) => {
            const framing = destinationVariant(candidate);
            return (
              <Button
                variant="ghost"
                role="tab"
                aria-selected={candidate === mode}
                className={`flex-1 rounded-chip text-xs ${
                  candidate === mode ? "is-active bg-accent-soft text-accent" : "text-ink-soft"
                }`}
                key={candidate}
                onClick={() => onSelectMode(candidate)}
              >
                {framing.title}
              </Button>
            );
          })}
        </div>
      ) : null}

      <div className="destination-body flex flex-col gap-2 overflow-y-auto">
        <div className="destination-count flex items-baseline gap-1.5">
          <strong className="text-2xl font-semibold text-accent">{items.length}</strong>
          <span className="text-sm text-ink-soft">collated</span>
          {lanes.blue > 0 ? (
            <span
              className="destination-private-pill rounded-chip border border-accent-line bg-accent-soft px-2 py-0.5 text-2xs font-semibold text-accent"
              data-private-count={lanes.blue}
            >
              {lanes.blue} private
            </span>
          ) : null}
        </div>
        {empty ? (
          <p className="destination-empty m-0 text-sm leading-snug text-ink-faint">
            The draft is empty. Dispose something and it collates here toward{" "}
            {variant.signLabel.toLowerCase()}.
          </p>
        ) : (
          <ol
            className="destination-staged m-0 flex list-none flex-col gap-1 p-0"
            aria-label="Collated dispositions"
          >
            {draft.map((entry) => (
              <li
                className="destination-staged-item flex items-center gap-2 rounded-control bg-raised px-2 py-1.5"
                data-path={entry.path}
                key={entry.id}
              >
                <span
                  className={`destination-staged-type grid size-[18px] shrink-0 place-items-center rounded-chip text-2xs font-bold ${
                    TYPE_BADGE[entry.type] ?? TYPE_BADGE.comment
                  }`}
                  data-type={entry.type}
                >
                  {entry.type[0]?.toUpperCase()}
                </span>
                <span className="destination-staged-path min-w-0 truncate font-mono text-xs text-ink-soft">
                  {entry.path}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <footer className="destination-foot flex flex-col gap-2">
        <Button
          size="lg"
          className="destination-open-draft w-full text-base"
          disabled={empty}
          onClick={() => onOpenDraft?.()}
        >
          Open the draft
          <Icon icon={ArrowRight} className="size-3.5" />
        </Button>
        {canHandoff ? (
          <Button
            variant="outline"
            size="lg"
            className="destination-handoff w-full text-base"
            onClick={() => onHandoff?.()}
          >
            Hand off to agent
            <Icon icon={ArrowRight} className="size-3.5" />
          </Button>
        ) : null}
      </footer>
    </aside>
  );
}
