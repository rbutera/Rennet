import type { Annotation, Proposal } from "@rennet/types";
import { Button, Textarea } from "@rennet/ui";

// ─────────────────────────────────────────────────────────────────────────────
// L3 — the orchestrator's hand. Glass doctrine: these marks are CHROME, visually
// distinct, and must never look like L1 analysis or L2 human judgment. Every L3
// element carries `data-l3` and its own `l3-*` treatment (a hand glyph + dashed
// chrome), so the reviewer always knows the agent, not they, put it there.
// ─────────────────────────────────────────────────────────────────────────────

/** An L3 annotation: an orchestrator mark, ephemeral until the user pins it. */
export function AnnotationMark({
  annotation,
  onPin,
  onClear,
}: {
  annotation: Annotation;
  onPin(annotationId: string): void;
  onClear(annotationId: string): void;
}) {
  return (
    <div
      className={`l3-annotation l3-${annotation.kind} flex items-start gap-2.5 rounded-surface border border-dashed border-accent-line bg-accent-surface px-3 py-2.5 text-base text-ink-soft ${annotation.pinned ? "is-pinned border-solid" : ""}`}
      data-l3="annotation"
    >
      <span
        className="l3-hand text-base leading-relaxed text-accent"
        aria-hidden="true"
        title="Orchestrator annotation"
      >
        ◇
      </span>
      <span className="l3-body min-w-0 flex-1 font-serif">{annotation.body}</span>
      <div className="l3-actions flex gap-1.5">
        <Button
          variant="outline"
          size="xs"
          className="l3-btn font-sans text-2xs text-ink-soft"
          onClick={() => onPin(annotation.annotationId)}
        >
          {annotation.pinned ? "Pinned" : "Pin"}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="l3-btn font-sans text-2xs text-ink-soft"
          onClick={() => onClear(annotation.annotationId)}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

/**
 * An L3 proposal rendered next to its target with accept / edit / dismiss.
 * Edit-then-accept is first-class: opening the editor lets the reviewer reshape
 * the body before accepting. Only acceptance creates L2 (the handler decides);
 * dismiss and edit stay on L3.
 */
export function ProposalMark({
  proposal,
  editing = false,
  draft = "",
  onAccept,
  onEdit,
  onChangeDraft,
  onDismiss,
}: {
  proposal: Proposal;
  editing?: boolean;
  draft?: string;
  onAccept(): void;
  onEdit(): void;
  onChangeDraft(value: string): void;
  onDismiss(): void;
}) {
  return (
    <div
      className="l3-proposal flex items-start gap-2.5 rounded-surface border border-dashed border-accent-line bg-accent-surface px-3 py-2.5 text-base text-ink-soft"
      data-l3="proposal"
      data-proposal-kind={proposal.kind}
    >
      <span
        className="l3-hand text-base leading-relaxed text-accent"
        aria-hidden="true"
        title="Orchestrator proposal"
      >
        ◇
      </span>
      <div className="l3-proposal-body min-w-0 flex-1">
        <span className="l3-proposal-target block font-mono text-2xs leading-normal text-ink-faint">
          {proposal.target}
        </span>
        {editing ? (
          <Textarea
            className="l3-proposal-edit mt-1.5 min-h-0 font-sans"
            aria-label="Edit the proposed disposition"
            value={draft}
            onChange={(event) => onChangeDraft(event.target.value)}
          />
        ) : (
          <span className="l3-proposal-payload font-serif">{proposal.payload}</span>
        )}
      </div>
      <div className="l3-actions flex gap-1.5">
        <Button
          variant="outline"
          size="xs"
          className="l3-btn l3-accept font-sans text-2xs text-ink-soft hover:border-green-line hover:bg-green-soft hover:text-ink"
          onClick={onAccept}
        >
          {editing ? "Accept edit" : "Accept"}
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="l3-btn font-sans text-2xs text-ink-soft"
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          variant="outline"
          size="xs"
          className="l3-btn font-sans text-2xs text-ink-soft"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
