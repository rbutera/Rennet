import { cn } from "@rennet/ui";
import { Link2 } from "lucide-react";
import { Icon } from "../../components/icon";
import { AnchorReveal } from "../../review";
import { SourceChips, SpecDeltaBadge, StoryStatus } from "../design-meta";
import { InlineQuoteHighlight, QuoteHighlightLayer } from "../quote-highlight";
import type { ElementOf } from "../registry";
import { useBoardPatchsetId, useCodeRefs, useElements } from "./element-context";
import { BoardElement } from "./renderers";

// `requirement` (C05 3.4) — a shall-requirement and how the change covers it. A
// coverage chip reads the `met | gap | partial` verdict (green / danger / gold); the
// `trace` code_refs reveal on click through `AnchorReveal`. `shall` renders with the
// normative-grammar bolding (SHALL/WHEN/THEN) `RichText` already carries.

const COVERAGE_CHIP: Record<"met" | "gap" | "partial", string> = {
  met: "border-green-line text-green",
  gap: "border-accent-line text-accent",
  partial: "border-primary/40 text-primary",
};

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function CoverageChip({
  coverage,
  hunks,
  tests,
}: {
  readonly coverage: "met" | "gap" | "partial" | undefined;
  readonly hunks: number;
  readonly tests: number | undefined;
}) {
  if (coverage === undefined) return null;
  const label =
    coverage === "gap"
      ? `unimplemented · ${countLabel(hunks, "hunk")}`
      : `covered by ${countLabel(hunks, "hunk")}${
          tests === undefined ? "" : ` · ${countLabel(tests, "test")}`
        }${coverage === "partial" ? " · partial" : ""}`;
  return (
    <span
      data-kind="coverage-chip"
      data-coverage={coverage}
      className={cn(
        "inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-2xs",
        COVERAGE_CHIP[coverage],
      )}
    >
      <Icon icon={Link2} className="size-3 shrink-0" />
      {label}
    </span>
  );
}

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
    coverage,
    trace,
    tests,
    status,
  } = element.data;
  const patchsetId = useBoardPatchsetId();
  const citations = useCodeRefs(trace ?? []);
  const scenarioElements = useElements(scenarios ?? []);
  return (
    <div
      data-kind="requirement"
      data-element-id={element.id}
      {...(coverage ? { "data-coverage": coverage } : {})}
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
        <ul
          data-kind="requirement-scenarios"
          className="flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground/60"
        >
          {scenarioElements.map((scenario) => {
            const clauses = scenario.kind === "prose" ? scenarioClauses(scenario) : undefined;
            return (
              <li key={scenario.id} data-scenario-ref={scenario.id} className="pl-0.5">
                {clauses ? (
                  <dl
                    data-kind="scenario-clauses"
                    data-element-id={scenario.id}
                    className="mt-1 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]"
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
                ) : (
                  <BoardElement element={scenario} />
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {coverage !== undefined || source !== undefined || (relatedFiles?.length ?? 0) > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <CoverageChip coverage={coverage} hunks={citations.length} tests={tests} />
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
