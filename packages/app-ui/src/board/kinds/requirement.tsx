import { AnchorReveal } from "../../review";
import { SourceChips, SpecDeltaBadge, StoryStatus } from "../design-meta";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefs, useElements } from "./element-context";
import { ProseElement } from "./prose";
import { BoardElement } from "./renderers";

// `requirement` (C05 3.4) — a shall-requirement, its scenarios, and the code it cites:
// the `trace` code_refs reveal on click through `AnchorReveal`. `shall` renders with the
// normative-grammar bolding (SHALL/WHEN/THEN) `RichText` already carries.

function scenarioClauses(
  element: ElementOf<"prose">,
): { readonly condition: string; readonly response: string } | undefined {
  const value = (element.data as { scenario_clauses?: unknown }).scenario_clauses;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const clauses = value as Record<string, unknown>;
  return typeof clauses.condition === "string" && typeof clauses.response === "string"
    ? { condition: clauses.condition, response: clauses.response }
    : undefined;
}

export function RequirementElement({ element }: { readonly element: ElementOf<"requirement"> }) {
  const {
    shall,
    name,
    capability,
    scenarios,
    related_files: relatedFiles,
    source,
    spec_delta: specDelta,
    trace,
    status,
  } = element.data;
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(trace ?? []);
  const scenarioElements = useElements(scenarios ?? []);
  return (
    <div
      data-kind="requirement"
      data-element-id={element.id}
      {...(specDelta ? { "data-spec-delta": specDelta } : {})}
      className="flex flex-col gap-2"
    >
      {name || capability || specDelta || status ? (
        <div className="flex flex-wrap items-center gap-2">
          {name ? (
            <h3 className="font-semibold text-base text-foreground">
              <InlineQuoteHighlight text={name} elementId={element.id} />
            </h3>
          ) : null}
          {capability ? (
            <InlineQuoteHighlight
              text={capability}
              elementId={element.id}
              className="font-mono text-xs text-muted-foreground"
            />
          ) : null}
          <StoryStatus status={status} />
          {specDelta ? <SpecDeltaBadge delta={specDelta} /> : null}
        </div>
      ) : null}
      <QuoteHighlightLayer
        text={shall}
        elementId={element.id}
        patchsetId={patchsetId}
        keywords
        paragraphClassName="text-foreground/90 text-sm leading-relaxed"
      />
      {scenarioElements.length > 0 ? (
        <ul data-kind="requirement-scenarios" className="flex flex-col gap-1">
          {scenarioElements.map((scenario) => {
            const clauses = scenario.kind === "prose" ? scenarioClauses(scenario) : undefined;
            return (
              <li
                key={scenario.id}
                data-scenario-ref={scenario.id}
                className="flex gap-1.5 text-13 text-foreground/75 leading-relaxed"
              >
                <span aria-hidden="true" className="select-none text-muted-foreground/60">
                  ‣
                </span>
                {clauses ? (
                  <dl
                    data-kind="scenario-clauses"
                    data-element-id={scenario.id}
                    // No size of its own: the clauses ARE the row's text, so they inherit
                    // the row's 13px rather than dropping a step below the bullet beside them.
                    className="grid min-w-0 flex-1 gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]"
                  >
                    <dt className="font-medium text-muted-foreground">Trigger</dt>
                    <dd data-scenario-clause="condition" className="text-foreground/80">
                      <InlineQuoteHighlight text={clauses.condition} elementId={scenario.id} />
                    </dd>
                    <dt className="font-medium text-muted-foreground">Outcome</dt>
                    <dd data-scenario-clause="response" className="text-foreground/80">
                      <InlineQuoteHighlight text={clauses.response} elementId={scenario.id} />
                    </dd>
                  </dl>
                ) : scenario.kind === "prose" ? (
                  // A scenario is prose nested INSIDE this row, so the row's own type is
                  // what it should read at. Left to its top-level defaults, `ProseElement`
                  // would size the body at `text-sm` (overruling the 13px declared above —
                  // a paragraph's own class beats an inherited one) and cap it at the 640px
                  // reading measure, which narrows it again inside an already-indented flex
                  // column. Both come off; the row supplies size, colour and leading.
                  <ProseElement element={scenario} className="" paragraphClassName="" />
                ) : (
                  <BoardElement element={scenario} />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {source !== undefined || (relatedFiles?.length ?? 0) > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceChips sources={source ? [source] : []} />
          <SourceChips
            sources={(relatedFiles ?? []).map((path) => ({ path }))}
            kind="related-file"
          />
        </div>
      ) : null}
      {citations.length > 0 && <AnchorReveal citations={citations} />}
    </div>
  );
}
