// Quote-match carry for living-draft span rework (B11 cluster 5). When a rework
// regenerates an ask body, the reviewer's selected span may have moved inside the
// new text; this re-anchors it by MATCHING its quoted text against the regenerated
// draft — reusing the lineage matcher (`classifyLineage`), never a second matcher.
//
// Fail-closed, exactly as the lineage contract demands (§3.4, `AUTO_CARRY_LINEAGES`
// is `exact`-only): the span carries ONLY to a byte-identical, uniquely-placed
// block in the regenerated draft. An ambiguous or merely-similar candidate returns
// `null` — the span did not survive regeneration, so the caller keeps the old
// anchor rather than silently pointing the reviewer's thread at the wrong text.

import { autoCarries, normalizeQuote } from "@rennet/protocol";
import { classifyLineage } from "../lineage-matcher";

/** Split a draft into candidate blocks (blank-line-separated), each a match target. */
function draftBlocks(draft: string): string[] {
  return draft
    .split(/\n[ \t]*\n/)
    .map((block) => normalizeQuote(block).trim())
    .filter((block) => block.length > 0);
}

/**
 * Re-anchor a reworked `span` across a `regenerated` draft by quote match. Returns
 * the matched block's text (the span's new home) when it carries `exact`, else null
 * (fail-closed). Pure — reuses `classifyLineage`; the block is `path:"draft"` for
 * every occurrence, so uniqueness rests on the body alone (the quote itself).
 */
export function carryQuoteAnchor(span: string, regenerated: string): string | null {
  const quote = normalizeQuote(span).trim();
  if (quote.length === 0) return null;
  const blocks = draftBlocks(regenerated);
  if (blocks.length === 0) return null;
  const result = classifyLineage(
    [{ id: "span", path: "draft", body: quote }],
    blocks.map((body, i) => ({ id: `b${i}`, path: "draft", body })),
  );
  const carried = result.classifications[0];
  if (!carried?.toId || !autoCarries(carried.lineage)) return null;
  const index = Number(carried.toId.slice(1));
  return blocks[index] ?? null;
}
