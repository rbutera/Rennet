import {
  DOMAIN_COUNT_KINDS,
  type DomainCountKind,
  type LensKind,
  type LensSection,
} from "@rennet/protocol";
import { Collapse, cn } from "@rennet/ui";
import { ChevronDown } from "lucide-react";
import { memo, useState } from "react";
import { Icon } from "../components/icon";
import { useRennetStore } from "../store";
import { SourceChips, SpecDeltaBadge } from "./design-meta";
import { DesignSectionBody } from "./design-structure";
import { useBoardId, useDesignMetaVisible, useElement } from "./kinds/element-context";
import { BoardChildren } from "./kinds/renderers";
import { InlineQuoteHighlight } from "./quote-highlight";
import { selectDeltaViewed } from "./viewed-delta";

// ─────────────────────────────────────────────────────────────────────────────
// The fold grammar (C05 cluster 4, Objective clauses 2/3 + #486). A top-level
// `LensSection` renders on `packages/ui`'s `Collapse`: folded, it is the one-line
// `gist` plus its per-kind `counts`; unfolded, it is the referenced `section`
// element's children through the registry (`BoardChildren`). This is the SEPARATE
// fold component for the projection's section entries — distinct from the inline
// `kinds/section.tsx` renderer that keeps the element registry total.
//
// Disclosure pattern (the spike's): the heading IS the toggle, and `Collapse` animates
// grid-rows rather than switching a conditional render. It mounts only the side it is
// showing, so exactly one of the two Collapses below holds nodes at rest (perf audit
// §5 H2 — this pair used to render the fold line AND the whole body at once, which is
// why folding a 700-claim board freed nothing). The trade is that folding a section
// discards its children's own fold state: reopening a section reopens its findings at
// their defaults. That is the fix, not a regression to route around.
//
// Delta marks (#486): a section carrying `delta: "new" | "reworked"` opens EXPANDED
// and wears a transient gold dot (`bg-primary`) while unviewed; interacting (toggling
// the heading, or clicking the folded gist) marks it viewed through the UI-only
// `viewedDelta` slice, clearing the dot. Absence of a delta = carried-forward, no dot.
// ─────────────────────────────────────────────────────────────────────────────

const DELTA_LABEL: Record<"new" | "reworked", string> = {
  new: "new this round",
  reworked: "reworked this round",
};

const LEGACY_COUNT_KIND: Readonly<Record<string, DomainCountKind | undefined>> = {
  finding: "findings",
  decision: "decisions",
  requirement: "requirements",
  order_step: "steps",
  round_outcome: "outcomes",
  noise_verdict: "groups",
  code_ref: "files",
  review_comment: "comments",
};

const SINGULAR: Readonly<Record<DomainCountKind, string>> = {
  findings: "finding",
  decisions: "decision",
  requirements: "requirement",
  steps: "step",
  outcomes: "outcome",
  groups: "group",
  files: "file",
  comments: "comment",
};

/** Convert current domain counts and legacy raw-kind counts into one stable reading line. */
export function sectionCountText(counts: LensSection["counts"]): string {
  const totals = new Map<DomainCountKind, number>();
  for (const [key, count] of Object.entries(counts)) {
    const domain = DOMAIN_COUNT_KINDS.includes(key as DomainCountKind)
      ? (key as DomainCountKind)
      : LEGACY_COUNT_KIND[key];
    if (domain !== undefined && count > 0) totals.set(domain, (totals.get(domain) ?? 0) + count);
  }
  return DOMAIN_COUNT_KINDS.flatMap((domain) => {
    const count = totals.get(domain);
    if (count === undefined) return [];
    return [`${count} ${count === 1 ? SINGULAR[domain] : domain}`];
  }).join(" · ");
}

/** The folded fold-line: a readable gist, then domain-object counts on their own line. */
function FoldLine({
  gist,
  counts,
}: {
  readonly gist: string;
  readonly counts: LensSection["counts"];
}) {
  const countText = sectionCountText(counts);
  return (
    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
      <span className="w-full text-muted-foreground text-sm leading-relaxed">{gist}</span>
      {countText.length > 0 ? (
        <span data-kind="section-counts" className="text-muted-foreground/60 text-xs">
          {countText}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Render one top-level board section. `entry` is the projection's fold-line; the
 * section element (`entry.ref`) is resolved through the board pool for its title and
 * children.
 *
 * EVERY section arrives folded, on every lens, including a delta section (Rai, 2026-09-04:
 * "each foldable should be folded by default.. so you only read the summaries to begin
 * with and you can expand to read the full detail"). A delta section keeps its dot, which
 * is what marks it as new — the fold is the reading grammar, not the marker. `defaultOpen`
 * is the escape hatch for a caller that genuinely needs one open; nothing passes it today.
 *
 * `memo`'d: on a big board the sections are the render units, and their props (`entry`
 * comes straight out of the resolved board) are stable for as long as the board is, so a
 * store write that re-renders the document stops at the section boundary.
 */
export const Section = memo(function Section({
  entry,
  lens,
  defaultOpen,
}: {
  readonly entry: LensSection;
  readonly lens?: LensKind;
  readonly defaultOpen?: boolean;
}) {
  const boardId = useBoardId();
  const designMeta = useDesignMetaVisible();
  const el = useElement(entry.ref);
  const viewed = useRennetStore(selectDeltaViewed(boardId, entry.ref));
  const markViewed = useRennetStore((s) => s.viewedDeltaActions.markDeltaViewed);
  const [open, setOpen] = useState(defaultOpen ?? false);

  // A dangling / non-section ref renders nothing (mirrors the pool's other resolvers).
  if (el?.kind !== "section") return null;
  const { title, children, sources, spec_delta: specDelta } = el.data;

  const showDot = entry.delta !== undefined && !viewed;
  const headingLabel = [
    title,
    ...(specDelta === undefined ? [] : [`${specDelta} specification`]),
    ...(entry.delta === undefined ? [] : [DELTA_LABEL[entry.delta]]),
  ].join(", ");
  const interact = () => {
    setOpen((o) => !o);
    if (entry.delta !== undefined) markViewed(boardId, entry.ref);
  };

  return (
    <section
      id={entry.ref}
      data-kind="board-section"
      data-section-id={entry.ref}
      {...(entry.delta ? { "data-delta": entry.delta } : {})}
      {...(specDelta ? { "data-spec-delta": specDelta } : {})}
      data-open={open}
      className="flex scroll-mt-6 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            onClick={interact}
            aria-expanded={open}
            aria-label={`Toggle ${title}`}
            className="flex shrink-0 items-center gap-2 text-left"
          >
            <Icon
              icon={ChevronDown}
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
            {showDot ? (
              <span
                data-testid="delta-dot"
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
          </button>
          <InlineQuoteHighlight
            text={title}
            elementId={entry.ref}
            onActivate={interact}
            ariaLabel={headingLabel}
            ariaExpanded={open}
            className="min-w-0 flex-1 cursor-pointer font-medium text-foreground text-lg"
          />
          {specDelta ? <SpecDeltaBadge delta={specDelta} /> : null}
        </h2>
        <SourceChips sources={designMeta ? (sources ?? []) : []} />
      </div>
      <Collapse open={!open}>
        <button
          type="button"
          onClick={interact}
          className="flex w-full pl-5 text-left transition-colors hover:text-foreground/80"
        >
          <FoldLine gist={entry.gist} counts={entry.counts} />
        </button>
      </Collapse>
      <Collapse open={open}>
        <div className="flex flex-col gap-6 pl-5">
          {lens === "design" ? (
            <DesignSectionBody section={el} />
          ) : (
            <BoardChildren ids={children} />
          )}
        </div>
      </Collapse>
    </section>
  );
});
