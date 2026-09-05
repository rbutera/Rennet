import type { HostElement } from "@rennet/protocol";
import { GitCommitHorizontal } from "lucide-react";
import { Icon } from "../../components/icon";
import { CodeTabs } from "../../review";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardElementIndex, useBoardPatchsetId, useCodeRefs } from "./element-context";

// `decision` (C05 3.4) — a recovered design decision: the statement, the why, the
// alternatives weighed, and the evidence. Evidence is a list of `code_ref` ids shown
// as tabbed sites through C4's `CodeTabs`; alternatives are free text (see
// `alternativeText` for the entries that are not, and why).
//
// A decision is a BORDERED CARD, not loose prose (prototype `lens-board.tsx:381-414`):
// the commit glyph and the box are what separate one weighed judgement from the next
// when several sit in a column. The reasoning, the roads not taken and the evidence
// indent under the statement, so the glyph column reads as the decision's spine.

/**
 * The text to print for one `alternatives` entry.
 *
 * `alternatives` is a TEXT field everywhere that reads it — lint's `decision-grounded`
 * calls it a "frozen `string[]`" and the Design obligation check compares its entries to
 * the artifact's stated alternatives verbatim. But `AUTHORED_BOARD_SCHEMA` has declared
 * it `element` since B3 and named its input `alternative_ids`, so seats drafting against
 * that surface minted a `prose` element per alternative and put the ID in the array. The
 * reader then got `alt-bind-1 \u00b7 alt-bind-2` where the roads not taken belonged, and
 * the prose itself sat orphaned in the element pool — under no section, so invisible.
 *
 * The Decisions prompt now says the field is plain text. This resolves the boards already
 * written: an entry naming an element of THIS board prints that element's text, and
 * anything else prints itself, which is the plain-text case.
 *
 * A resolved element was authored to stand alone, so it carries its own label
 * ("**Alternative not taken:** ..."). The line above already says "Not taken", so a
 * leading bold label is dropped rather than read out twice.
 */
function alternativeText(entry: string, pool: ReadonlyMap<string, HostElement>): string {
  const element = pool.get(entry);
  if (element === undefined) return entry;
  const data = element.data as { markdown?: unknown; body?: unknown; title?: unknown };
  const text = [data.markdown, data.body, data.title].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return text === undefined ? entry : text.replace(/^\s*\*\*[^*\n]{1,80}:\*\*\s*/, "").trim();
}

export function DecisionElement({ element }: { readonly element: ElementOf<"decision"> }) {
  const { statement, why, alternatives, evidence, inferred } = element.data;
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(evidence);
  const pool = useBoardElementIndex();
  const roadsNotTaken = alternatives.map((entry) => alternativeText(entry, pool));
  return (
    <div
      data-kind="decision"
      data-element-id={element.id}
      className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <Icon
          icon={GitCommitHorizontal}
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <h3 className="min-w-0 flex-1 font-medium text-13 text-foreground leading-snug">
          <InlineQuoteHighlight text={statement} elementId={element.id} />
        </h3>
        {inferred === true && (
          // The prompts (`prompts/decisions.md:34`) make the model mark a decision it
          // RECONSTRUCTED rather than read off an artifact. The badge is the reader's
          // only warning that the statement is a reconstruction, so it is bound to the
          // stamp and never to its absence.
          <span
            data-kind="decision-inferred"
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-10 text-muted-foreground"
          >
            inferred
          </span>
        )}
      </div>
      <QuoteHighlightLayer
        text={why}
        elementId={element.id}
        patchsetId={patchsetId}
        className="pl-5"
        // 13px, one step UNDER the 13.5px statement above and one over the 12.5px
        // alternatives below (prototype `lens-board.tsx:384-402`). At `text-sm` the
        // reasoning outsized the decision it explains — the hierarchy read inverted.
        paragraphClassName="text-foreground/85 text-13 leading-relaxed"
      />
      {alternatives.length > 0 && (
        // One inline line, not a headed list: the roads not taken are context for the
        // decision, and a heading over two words outweighed the words (prototype
        // `lens-board.tsx:400-402`). Same data, dot-joined.
        <p
          data-kind="decision-alternatives"
          className="pl-5 text-12-5 text-muted-foreground leading-relaxed"
        >
          Not taken:{" "}
          <InlineQuoteHighlight text={roadsNotTaken.join(" · ")} elementId={element.id} />
        </p>
      )}
      {citations.length > 0 && (
        <div className="pl-5">
          <CodeTabs citations={citations} />
        </div>
      )}
    </div>
  );
}
