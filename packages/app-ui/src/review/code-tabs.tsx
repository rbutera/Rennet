import { useState } from "react";
import { basename } from "../canvas/symbol";
import { type CodeRef, spanToBlock, useSpanRead } from "./citations";
import { CodeBlock } from "./code-block";
import { ReferenceChip } from "./reference-chip";

// ─────────────────────────────────────────────────────────────────────────────
// Multi-site evidence (C4). CodeTabs = quiet pill tabs over several cited sites, one
// visible CodeBlock card at a time (tab strip hidden at a single excerpt). AnchorReveal
// = a row of chips that fetch on click and fold on a re-click. Both hydrate every cited
// span through review/citations.ts (the span-read seam), NEVER a working tree; both use
// reference-chip for their pill/chip markup. The seam's per-key cache dedupes a re-opened
// chip, so folding then re-opening does NOT refetch. An unreadable citation renders one
// honest line, never a silent empty block.
// ─────────────────────────────────────────────────────────────────────────────

/** Hydrate one cited span and render it as a CodeBlock (or an honest line while it can't). */
function HydratedBlock({ citation }: { citation: CodeRef }) {
  const { data, error } = useSpanRead(citation);
  const label = `${basename(citation.path)}:${citation.startLine}`;
  if (error) {
    return (
      <p className="text-2xs text-muted-foreground">
        {citation.path} is not readable from the captured patchset.
      </p>
    );
  }
  if (!data) return <p className="text-2xs text-muted-foreground">Loading {label}…</p>;
  const block = spanToBlock(citation, data);
  return (
    <CodeBlock
      code={block.code}
      path={citation.path}
      startLine={block.startLine}
      highlightLines={block.highlightLines}
    />
  );
}

/** Tabbed evidence viewer: one tab per cited site, one visible card. */
export function CodeTabs({ citations }: { citations: readonly CodeRef[] }) {
  const [active, setActive] = useState(0);
  const citation = citations[active];
  if (!citation) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {citations.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          {citations.map((tab, index) => (
            <ReferenceChip
              key={`${tab.path}:${tab.startLine}`}
              path={tab.path}
              startLine={tab.startLine}
              endLine={tab.endLine}
              active={index === active}
              onClick={() => setActive(index)}
            />
          ))}
        </div>
      )}
      <HydratedBlock citation={citation} />
    </div>
  );
}

/** Click-to-reveal citations: chips that fetch the cited span on click and fold on re-click. */
export function AnchorReveal({ citations }: { citations: readonly CodeRef[] }) {
  const [active, setActive] = useState<number | null>(null);
  const activeCitation = active === null ? undefined : citations[active];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {citations.map((citation, index) => (
          <ReferenceChip
            key={`${citation.path}:${citation.startLine}`}
            path={citation.path}
            startLine={citation.startLine}
            endLine={citation.endLine}
            active={active === index}
            title={active === index ? "Hide code" : `Show ${citation.path}:${citation.startLine}`}
            onClick={() => setActive((current) => (current === index ? null : index))}
          />
        ))}
      </div>
      {activeCitation && <HydratedBlock citation={activeCitation} />}
    </div>
  );
}
