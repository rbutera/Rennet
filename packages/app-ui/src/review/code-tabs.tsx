import { useState } from "react";
import { basename } from "../canvas/symbol";
import { type CodeRef, refKey, spanToBlock, useSpanRead } from "./citations";
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

/** Hydrate one cited span and render it as a CodeBlock (or an honest line while it can't).
 *  Shared by CodeTabs/AnchorReveal here and by rich-text's citation reveal. */
export function CitationBlock({ citation }: { citation: CodeRef }) {
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
    // Key by the FULL ref: a citation switch remounts the surface so a half-written
    // line comment for one file can never save through another file's callbacks even
    // when the two cited spans share an absolute line number.
    <CodeBlock
      key={refKey(citation)}
      code={block.code}
      path={citation.path}
      startLine={block.startLine}
      highlightLines={block.highlightLines}
    />
  );
}

/** Tabbed evidence viewer: one tab per cited site, one visible card. */
export function CodeTabs({ citations }: { citations: readonly CodeRef[] }) {
  // Track the selected TAB by ref identity, not array index: shrinking or reordering the
  // list keeps (or gracefully drops to the first) the same citation, never a stale index.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const citation = citations.find((c) => refKey(c) === activeKey) ?? citations[0];
  if (!citation) return null;
  const currentKey = refKey(citation);
  return (
    <div className="flex flex-col gap-1.5">
      {citations.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          {citations.map((tab) => {
            const key = refKey(tab);
            return (
              <ReferenceChip
                key={key}
                path={tab.path}
                startLine={tab.startLine}
                endLine={tab.endLine}
                active={key === currentKey}
                onClick={() => setActiveKey(key)}
              />
            );
          })}
        </div>
      )}
      <CitationBlock citation={citation} />
    </div>
  );
}

/** Click-to-reveal citations: chips that fetch the cited span on click and fold on re-click. */
export function AnchorReveal({ citations }: { citations: readonly CodeRef[] }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeCitation = citations.find((c) => refKey(c) === activeKey);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {citations.map((citation) => {
          const key = refKey(citation);
          const isActive = key === activeKey;
          return (
            <ReferenceChip
              key={key}
              path={citation.path}
              startLine={citation.startLine}
              endLine={citation.endLine}
              active={isActive}
              title={
                isActive
                  ? `Hide ${citation.path}:${citation.startLine}`
                  : `Show ${citation.path}:${citation.startLine}`
              }
              onClick={() => setActiveKey((current) => (current === key ? null : key))}
            />
          );
        })}
      </div>
      {activeCitation && <CitationBlock citation={activeCitation} />}
    </div>
  );
}
