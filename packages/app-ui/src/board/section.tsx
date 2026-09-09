import {
  DOMAIN_COUNT_KINDS,
  type DomainCountKind,
  type HostElement,
  type LensKind,
  type LensSection,
} from "@rennet/protocol";
import { COLLAPSE_MS, Collapse, cn } from "@rennet/ui";
import { ChevronDown } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/icon";
import { useRennetStore } from "../store";
import { SourceChips, SpecDeltaBadge } from "./design-meta";
import { DesignSectionBody } from "./design-structure";
import {
  useBoardElementIndex,
  useBoardId,
  useDesignMetaVisible,
  useElement,
} from "./kinds/element-context";
import { BoardChildren } from "./kinds/renderers";
import { InlineQuoteHighlight } from "./quote-highlight";
import { PreviewText, sectionPreview } from "./section-preview";
import { selectDeltaViewed } from "./viewed-delta";

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
  groups: "region",
  files: "file",
  comments: "comment",
};

/** The renderable descendants of a Flagged section: a `code_ref` citation is dropped (a
 *  finding renders its own `code`; a bare one is the #927 orphaned code block), a nested
 *  section's frame is flattened away (the malformed shape move two retires), and every other
 *  child — finding, reviewer `message` thread, prose, callout, annotation — is kept in place.
 *  Recurses with a visited guard so a malformed cycle cannot loop; the finding half of what
 *  it reaches is the same set the projection's `reachableFindingIds` counts. */
function flaggedRenderIds(
  ids: readonly string[],
  index: ReadonlyMap<string, HostElement>,
  visited: Set<string> = new Set(),
): string[] {
  return ids.flatMap((id) => {
    if (visited.has(id)) return [];
    visited.add(id);
    const element = index.get(id);
    if (element === undefined || element.kind === "code_ref") return [];
    if (element.kind === "section") return flaggedRenderIds(element.data.children, index, visited);
    return [id];
  });
}

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
    return [
      `${count} ${count === 1 ? SINGULAR[domain] : domain === "groups" ? "regions" : domain}`,
    ];
  }).join(" · ");
}

/**
 * Render one top-level board section. The preview derives from the current children; the
 * section element (`entry.ref`) is resolved through the board pool for its title and
 * children.
 *
 * EVERY section arrives folded, on every lens but one (Rai, 2026-09-04: "each foldable
 * should be folded by default.. so you only read the summaries to begin with and you can
 * expand to read the full detail"). A delta section keeps its dot, which is what marks it
 * as new — the fold is the reading grammar, not the marker. `defaultOpen` is the escape
 * hatch for a caller that genuinely needs one open; nothing passes it today.
 *
 * The exception is `foldable={false}` (Rai, 2026-09-08): a Flagged section is a plain
 * heading over its findings, never a fold. Its children are findings, and a folded finding
 * — severity chip, claim, concurrence — already IS the summary; folding the section on top
 * of that replaced three chips with a list of bare titles, which said less at a glance
 * than the rows it hid. A non-foldable section has no chevron, no preview and no toggle;
 * it is open, and `data-open` says so.
 *
 * `memo`'d: on a big board the sections are the render units, and their props (`entry`
 * comes straight out of the resolved board) are stable for as long as the board is, so a
 * store write that re-renders the document stops at the section boundary.
 */
export const Section = memo(function Section({
  entry,
  lens,
  defaultOpen,
  foldable = true,
}: {
  readonly entry: LensSection;
  readonly lens?: LensKind;
  readonly defaultOpen?: boolean;
  readonly foldable?: boolean;
}) {
  const boardId = useBoardId();
  const index = useBoardElementIndex();
  const root = useRef<HTMLElement>(null);
  const designMeta = useDesignMetaVisible();
  const el = useElement(entry.ref);
  const viewed = useRennetStore(selectDeltaViewed(boardId, entry.ref));
  const markViewed = useRennetStore((s) => s.viewedDeltaActions.markDeltaViewed);
  const [unfolded, setOpen] = useState(defaultOpen ?? false);
  const open = !foldable || unfolded;
  const [target, setTarget] = useState<string | null>(null);
  const preview = useMemo(
    () => (el?.kind === "section" ? sectionPreview(el, index) : { kind: "empty" as const }),
    [el, index],
  );

  useEffect(() => {
    if (!open || target === null) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(
      () => {
        const child = [
          ...(root.current?.querySelectorAll<HTMLElement>("[data-element-id]") ?? []),
        ].find((node) => node.dataset.elementId === target);
        if (child) {
          child.tabIndex = -1;
          child.focus({ preventScroll: true });
          child.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        }
        setTarget(null);
      },
      reducedMotion ? 0 : COLLAPSE_MS,
    );
    return () => clearTimeout(timer);
  }, [open, target]);

  // A dangling / non-section ref renders nothing (mirrors the pool's other resolvers).
  if (el?.kind !== "section") return null;
  const { title, children, sources, spec_delta: specDelta } = el.data;

  // On Flagged, a section renders the renderable content it reaches, recursing nested
  // sections so the body agrees with the projection's reachable-findings count. A bare
  // `code_ref` child is dropped (a finding's own citation via its `code` field, which alone
  // renders as an orphaned code block with no prose — the #927 defect); a nested section's
  // own frame is flattened away (the malformed shape move two retires); everything else a
  // Flagged board legitimately holds — findings, reviewer `message` threads, prose, callouts
  // — renders in place. A finding renders its own cited code.
  const renderedChildren = lens === "flagged" ? flaggedRenderIds(children, index) : children;

  const countText = sectionCountText(entry.counts);
  const showDot = entry.delta !== undefined && !viewed;
  const headingLabel = [
    title,
    ...(specDelta === undefined ? [] : [`${specDelta} specification`]),
    ...(entry.delta === undefined ? [] : [DELTA_LABEL[entry.delta]]),
  ].join(", ");
  const interact = () => {
    setTarget(null);
    setOpen((o) => !o);
    if (entry.delta !== undefined) markViewed(boardId, entry.ref);
  };

  const locate = (id: string) => {
    setTarget(id);
    setOpen(true);
    if (entry.delta !== undefined) markViewed(boardId, entry.ref);
  };

  // A section with no toggle has no single act of opening to mark it viewed, so any
  // interaction inside it — a finding opened, a title clicked — is the reading.
  const viewedOnInteraction =
    !foldable && entry.delta !== undefined
      ? {
          onClickCapture: () => markViewed(boardId, entry.ref),
          onKeyDownCapture: (event: { key: string }) => {
            if (event.key === "Enter" || event.key === " ") markViewed(boardId, entry.ref);
          },
        }
      : {};
  return (
    <section
      ref={root}
      id={entry.ref}
      data-kind="board-section"
      data-section-id={entry.ref}
      {...(entry.delta ? { "data-delta": entry.delta } : {})}
      {...(specDelta ? { "data-spec-delta": specDelta } : {})}
      {...viewedOnInteraction}
      data-open={open}
      className="flex scroll-mt-6 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-2">
          {foldable ? (
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
          ) : showDot ? (
            <span
              data-testid="delta-dot"
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          ) : null}
          {foldable ? (
            <InlineQuoteHighlight
              text={title}
              elementId={entry.ref}
              onActivate={interact}
              ariaLabel={headingLabel}
              ariaExpanded={open}
              className="min-w-0 flex-1 cursor-pointer font-medium text-foreground text-lg"
            />
          ) : (
            <InlineQuoteHighlight
              text={title}
              elementId={entry.ref}
              className="min-w-0 flex-1 font-medium text-foreground text-lg"
            />
          )}
          {specDelta ? <SpecDeltaBadge delta={specDelta} /> : null}
        </h2>
        {countText ? (
          <span data-kind="section-counts" className="text-muted-foreground/60 text-xs">
            {countText}
          </span>
        ) : null}
        <SourceChips sources={designMeta ? (sources ?? []) : []} />
      </div>
      <Collapse open={foldable && !open}>
        {/* The fold is an INDEX: each row is the heading of something inside, and
            pressing it opens the section on that thing. It reads in the body's own ink
            and lights on hover, because a run of muted lines under a heading read as
            a dimmed excerpt — text to skim past — not as a list you can take (Rai,
            2026-09-08: "the collapsed sections are unreadable / unusable"). */}
        {preview.kind === "headings" ? (
          <ol
            aria-label={`${title} contents`}
            data-kind="section-index"
            className="flex flex-col pl-5"
          >
            {preview.entries.map(({ id, text, delta }) => (
              <li key={id} className="border-line/60 border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() => locate(id)}
                  className="-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-foreground/80 text-sm leading-snug transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* A heading that runs long (a finding's first line, an over-written
                      title) is clamped like the paragraph preview, not left to fill the fold. */}
                  <span className="line-clamp-2 min-w-0 flex-1">
                    <PreviewText text={text} />
                  </span>
                  {delta ? <SpecDeltaBadge delta={delta} /> : null}
                </button>
              </li>
            ))}
          </ol>
        ) : preview.kind === "paragraph" ? (
          <button
            type="button"
            onClick={() => locate(preview.entry.id)}
            className="w-full rounded-sm pl-5 text-left text-foreground/80 text-sm leading-relaxed transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span data-kind="section-paragraph-preview" className="line-clamp-2">
              <PreviewText text={preview.entry.text} />
            </span>
          </button>
        ) : null}
      </Collapse>
      <Collapse open={open}>
        <div className="flex flex-col gap-6 pl-5">
          {lens === "design" ? (
            <DesignSectionBody section={el} />
          ) : (
            <BoardChildren ids={renderedChildren} />
          )}
        </div>
      </Collapse>
    </section>
  );
});
