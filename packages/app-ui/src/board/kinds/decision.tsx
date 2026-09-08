import type { HostElement } from "@rennet/protocol";
import { GitCommitHorizontal } from "lucide-react";
import { Icon } from "../../components/icon";
import { CodeTabs } from "../../review";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { decisionHeading } from "../section-preview";
import { useBoardElementIndex, useBoardPatchsetId, useCodeRefs } from "./element-context";

// `decision` (C05 3.4) — a recovered design decision: the statement, the why, the
// alternatives weighed, and the evidence. Evidence is a list of `code_ref` ids shown
// as tabbed sites through C4's `CodeTabs`; alternatives are free text (see
// `alternativeText` for the entries that are not, and why).
//
// A decision is a BORDERED CARD, not loose prose (prototype `lens-board.tsx:381-414`):
// the commit glyph and the box are what separate one weighed judgement from the next
// when several sit in a column. The reasoning, the roads not taken and the evidence
// sit beneath a concise heading; the complete statement remains readable in the body.
//
// Inside the card the type has three steps, and every one is a ramp step (Rai,
// 2026-09-08, after a card whose title, labels and body all read at the same weight as a
// wall): the heading at 16 semibold, the block labels ("Rationale", "Not taken",
// "Evidence") at 14 semibold in the foreground colour, and the prose at the 15 reading
// size with the block gaps opened up so each block is a paragraph, not a line.

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
  const heading = decisionHeading(element.data);
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(evidence);
  const pool = useBoardElementIndex();
  const roadsNotTaken = alternatives.map((entry) => alternativeText(entry, pool));
  return (
    <div
      data-kind="decision"
      data-element-id={element.id}
      className="flex flex-col gap-3 rounded-xl border border-border px-4 py-3.5"
    >
      <div className="flex items-start gap-2">
        <Icon icon={GitCommitHorizontal} className="mt-1 size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 font-semibold text-base text-foreground leading-snug">
          <InlineQuoteHighlight text={heading} elementId={element.id} />
        </h3>
        {inferred === true && (
          // The prompts (`prompts/decisions.md:34`) make the model mark a decision it
          // RECONSTRUCTED rather than read off an artifact. The badge is the reader's
          // only warning that the statement is a reconstruction, so it is bound to the
          // stamp and never to its absence.
          <span
            data-kind="decision-inferred"
            className="mt-0.5 shrink-0 rounded border border-border px-1.5 py-0.5 text-10 text-muted-foreground"
          >
            inferred
          </span>
        )}
      </div>
      {heading !== statement && (
        <QuoteHighlightLayer
          text={statement}
          elementId={element.id}
          patchsetId={patchsetId}
          className="pl-6"
          paragraphClassName="font-prose text-15 text-foreground leading-relaxed"
        />
      )}
      {why.trim().length > 0 && (
        <div className="flex flex-col gap-1.5 pl-6">
          <h4 className="font-semibold text-foreground text-sm">Rationale</h4>
          <QuoteHighlightLayer
            text={why}
            elementId={element.id}
            patchsetId={patchsetId}
            paragraphClassName="font-prose text-15 text-foreground/85 leading-relaxed"
          />
        </div>
      )}
      {alternatives.length > 0 && (
        <div data-kind="decision-alternatives" className="flex flex-col gap-1.5 pl-6">
          <h4 className="font-semibold text-foreground text-sm">Not taken</h4>
          <ul className="list-disc space-y-1.5 pl-4 text-muted-foreground text-sm leading-relaxed">
            {roadsNotTaken.map((alternative) => (
              <li key={alternative}>
                <InlineQuoteHighlight text={alternative} elementId={element.id} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {citations.length > 0 && (
        <div className="flex flex-col gap-1.5 pl-6">
          <h4 className="font-semibold text-foreground text-sm">Evidence</h4>
          <CodeTabs citations={citations} />
        </div>
      )}
    </div>
  );
}
