import {
  DOMAIN_COUNT_KINDS,
  type DomainCountKind,
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
        {preview.kind === "headings" ? (
          <ul aria-label={`${title} contents`} className="flex flex-col gap-1 pl-5">
            {preview.entries.map(({ id, text }) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => locate(id)}
                  className="block w-full rounded-sm text-left text-muted-foreground text-sm leading-relaxed transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {/* A heading that runs long (a finding's first line, an over-written
                      title) is clamped like the paragraph preview, not left to fill the fold. */}
                  <span className="line-clamp-2">
                    <PreviewText text={text} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : preview.kind === "paragraph" ? (
          <button
            type="button"
            onClick={() => locate(preview.entry.id)}
            className="w-full rounded-sm pl-5 text-left text-muted-foreground text-sm leading-relaxed transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            <BoardChildren ids={children} />
          )}
        </div>
      </Collapse>
    </section>
  );
});
