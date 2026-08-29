import { SourceChips, SpecDeltaBadge } from "../design-meta";
import type { ElementOf } from "../registry";
import { BoardChildren } from "./renderers";

// `section` (C05 3.4, registry totality) — a nested section element encountered inside
// another element's children: its title plus its children through the registry. This
// is the INLINE renderer that keeps the `Record<BoardKind, …>` total; the top-level
// fold grammar (Collapse + gist + counts + delta marks) is the separate `board/
// section.tsx` component cluster 4 builds for the `LensSection` projection entries.

export function SectionElement({ element }: { readonly element: ElementOf<"section"> }) {
  const { title, children, sources, spec_delta: specDelta } = element.data;
  return (
    <section
      data-kind="section"
      data-element-id={element.id}
      {...(specDelta ? { "data-spec-delta": specDelta } : {})}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-base text-foreground">{title}</h3>
        {specDelta ? <SpecDeltaBadge delta={specDelta} /> : null}
        <SourceChips sources={sources ?? []} className="ml-auto" />
      </div>
      <BoardChildren ids={children} />
    </section>
  );
}
