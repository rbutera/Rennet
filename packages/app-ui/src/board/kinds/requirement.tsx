import { Fragment } from "react";
import { SourceChips, SpecDeltaBadge, StoryStatus } from "../design-meta";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { readScenario } from "../scenario-reading";
import { BoardAnchorReveal } from "./board-anchor-reveal";
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
        <ul data-kind="requirement-scenarios" className="flex flex-col gap-2.5">
          {scenarioElements.map((scenario) => {
            const reading =
              scenario.kind === "prose"
                ? readScenario(scenario.data.markdown, scenarioClauses(scenario))
                : { rows: [] };
            return (
              <li
                key={scenario.id}
                data-scenario-ref={scenario.id}
                // Each scenario is its own block under a hairline: the name is its
                // heading and the clauses sit in a keyword column beneath it, so a
                // requirement with nine scenarios reads as nine cases, not one run of
                // Trigger/Outcome pairs.
                className="flex flex-col gap-1 border-line border-l-2 pl-3 text-13 text-foreground/75 leading-relaxed"
              >
                {reading.rows.length > 0 ? (
                  <div
                    data-kind="scenario-clauses"
                    data-element-id={scenario.id}
                    className="flex min-w-0 flex-col gap-1"
                  >
                    {reading.name !== undefined ? (
                      <p className="font-medium text-foreground/90">
                        <InlineQuoteHighlight text={reading.name} elementId={scenario.id} />
                      </p>
                    ) : null}
                    <dl className="grid min-w-0 gap-x-3 gap-y-0.5 sm:grid-cols-[auto_1fr]">
                      {reading.rows.map((row, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional clauses of one scenario; two `And` rows share a keyword and have no identity beyond their order.
                        <Fragment key={index}>
                          <dt className="font-medium text-muted-foreground">{row.keyword}</dt>
                          <dd data-scenario-clause={row.clause} className="text-foreground/80">
                            <InlineQuoteHighlight text={row.text} elementId={scenario.id} />
                          </dd>
                        </Fragment>
                      ))}
                    </dl>
                  </div>
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
      {citations.length > 0 && <BoardAnchorReveal citations={citations} />}
    </div>
  );
}
