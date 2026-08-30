import {
  type AskEventBody,
  type AskProjection,
  type DraftBoard,
  type DraftElement,
  LENS_KINDS,
  type LensKind,
  type QuoteThread,
} from "@rennet/protocol";

export interface QuoteThreadReanchorInput {
  readonly projection: AskProjection;
  readonly sourceGeneration: string;
  readonly successorGeneration: string;
  readonly previous: ReadonlyMap<LensKind, DraftBoard>;
  readonly successor: ReadonlyMap<LensKind, DraftBoard>;
}

export interface SelectableBoardText {
  /** The board element `ProseSelectionLayer` records as the quote target. */
  readonly target: string;
  /** One reader-authored text field rendered beneath that target. */
  readonly text: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): readonly string[] {
  return typeof value === "string" ? [value] : [];
}

function scenarioClauseText(value: unknown): readonly [string, string] | undefined {
  const clauses = recordOf(value);
  return clauses !== undefined &&
    typeof clauses.condition === "string" &&
    typeof clauses.response === "string"
    ? [clauses.condition, clauses.response]
    : undefined;
}

function isRenderedGlossary(value: unknown): boolean {
  const glossary = recordOf(value);
  return (
    glossary !== undefined &&
    typeof glossary.term === "string" &&
    typeof glossary.definition === "string" &&
    Array.isArray(glossary.avoid) &&
    glossary.avoid.every((entry) => typeof entry === "string")
  );
}

function findingConcernText(concern: string): readonly string[] {
  const [body = concern, ...fixParts] = concern.split(/\*\*Fix:\*\*/);
  return fixParts.length === 0 ? [concern.trim()] : [body.trim(), fixParts.join("**Fix:**").trim()];
}

/**
 * The canonical reader-authored text fields selectable beneath one board element.
 * Element references and other machine ids are deliberately absent: they describe board
 * topology, but the reader never selected them as prose.
 */
function selectableTextOf(
  element: DraftElement,
  referencedScenarios: ReadonlySet<string>,
): readonly string[] {
  switch (element.kind) {
    case "finding":
      return findingConcernText(element.data.concern);
    case "decision":
      return [element.data.statement, element.data.why, ...element.data.alternatives];
    case "requirement":
      return [
        ...stringOf(element.data.name),
        ...stringOf(element.data.capability),
        element.data.shall,
      ];
    case "noise_verdict":
      return [element.data.reason];
    case "prose": {
      const scenario = referencedScenarios.has(element.id)
        ? scenarioClauseText(element.data.scenario_clauses)
        : undefined;
      if (scenario !== undefined) return scenario;
      return isRenderedGlossary(element.data.glossary_term) ? [] : [element.data.markdown];
    }
    case "callout":
      return [element.data.body];
    case "annotation":
      return [element.data.body];
    case "order_step":
      return [element.data.title];
    case "round_outcome":
      return [element.data.ask.text, element.data.note];
    case "section":
      return [element.data.title];
    case "code_ref":
      return [];
    default: {
      const exhaustive: never = element;
      return exhaustive;
    }
  }
}

/** Project a board onto the exact text corpus quote re-anchoring is allowed to search. */
export function selectableBoardText(board: DraftBoard): SelectableBoardText[] {
  const referencedScenarios = new Set(
    board.elements.flatMap((element) =>
      element.kind === "requirement" ? (element.data.scenarios ?? []) : [],
    ),
  );
  return board.elements.flatMap((element) =>
    selectableTextOf(element, referencedScenarios).flatMap((text) =>
      text.length === 0 ? [] : [{ target: element.id, text }],
    ),
  );
}

function occurrenceCount(text: string, quote: string): number {
  if (quote.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length - quote.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    count += 1;
    from = at + quote.length;
  }
  return count;
}

function sourceLensFor(
  previous: ReadonlyMap<LensKind, DraftBoard>,
  target: string,
  anchor: string,
): LensKind | undefined {
  const owners = LENS_KINDS.filter((lens) => {
    const board = previous.get(lens);
    if (board === undefined) return false;
    return selectableBoardText(board).some(
      (candidate) => candidate.target === target && occurrenceCount(candidate.text, anchor) > 0,
    );
  });
  return owners.length === 1 ? owners[0] : undefined;
}

function uniqueSuccessorTarget(board: DraftBoard | undefined, anchor: string): string | undefined {
  if (board === undefined) return undefined;
  const matches = selectableBoardText(board).flatMap(({ target, text }) =>
    Array.from({ length: occurrenceCount(text, anchor) }, () => target),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function scopedToGeneration(
  thread: QuoteThread,
  generation: string,
): thread is QuoteThread & { readonly target: string; readonly generation: string } {
  return thread.target !== undefined && thread.generation === generation;
}

function alreadyEquals(thread: QuoteThread, desired: QuoteThread): boolean {
  return (
    thread.lifecycle === desired.lifecycle &&
    thread.target === desired.target &&
    thread.generation === desired.generation
  );
}

/**
 * Plan durable `quote-open` overwrites for one board-generation replacement.
 * Applying the events and planning the same transition again yields no events.
 */
export function planQuoteThreadReanchors(input: QuoteThreadReanchorInput): AskEventBody[] {
  return Object.entries(input.projection.quoteThreads).flatMap(([threadId, thread]) => {
    if (!scopedToGeneration(thread, input.sourceGeneration)) return [];
    const sourceLens = sourceLensFor(input.previous, thread.target, thread.anchor);
    const successorTarget =
      sourceLens === undefined
        ? undefined
        : uniqueSuccessorTarget(input.successor.get(sourceLens), thread.anchor);
    const desired: QuoteThread =
      successorTarget === undefined
        ? { ...thread, lifecycle: "detached" }
        : {
            ...thread,
            lifecycle: "attached",
            target: successorTarget,
            generation: input.successorGeneration,
          };
    if (alreadyEquals(thread, desired)) return [];
    return [{ kind: "quote-open", threadId, thread: desired }];
  });
}
