/**
 * Host-owned composition for the two board effects of a returned work-order round:
 * resolved findings leave Flagged's render traversal, and Sequence gains one chronological
 * addressed chapter. The model drafts neither lifecycle. This pass is pure over the frozen
 * prior board, the fresh draft, the verified report, and durable reviewer-owned state.
 */

import {
  type AskEventBody,
  type ComposableAsk,
  type DraftBoard,
  type DraftElement,
  type FindingDisposition,
  type FindingRef,
  findingRefKey,
  type LensKind,
} from "@rennet/protocol";

const ROUND_ADDRESSED_NAMESPACE = "rennet:host:round-addressed:";
const HOST_AUTHOR = { kind: "orchestrator", id: "rennet:round-composition" } as const;

type FindingElement = Extract<DraftElement, { kind: "finding" }>;
type CodeRefElement = Extract<DraftElement, { kind: "code_ref" }>;
type RoundOutcomeElement = Extract<DraftElement, { kind: "round_outcome" }>;

export type FindingResolution =
  | {
      readonly kind: "reattached";
      readonly finding: FindingRef;
      readonly currentFindingId: string;
      readonly match: "stable-id" | "unique-semantic";
    }
  | {
      readonly kind: "detached";
      readonly finding: FindingRef;
      readonly reason:
        | "source-generation-mismatch"
        | "source-board-mismatch"
        | "previous-finding-not-unique"
        | "current-finding-not-uniquely-matched";
    };

export interface FindingRoundComposition {
  readonly board: DraftBoard;
  /** Why each durable resolved ref did or did not attach to this fresh draft. */
  readonly resolutions: readonly FindingResolution[];
}

export interface ComposeFindingRoundInput {
  readonly lens: LensKind;
  readonly current: DraftBoard;
  readonly previous: DraftBoard | undefined;
  /** The exact frozen generation represented by {@link previous}. */
  readonly previousGeneration: string;
  /** The exact frozen Flagged board represented by {@link previous}. */
  readonly previousBoardId?: string;
  readonly report: DraftBoard;
  readonly roundNumber: number;
  readonly dispatchedAsks: readonly ComposableAsk[];
  readonly findingDispositions: Readonly<Record<string, FindingDisposition>>;
}

interface AddressedOutcome {
  readonly outcome: RoundOutcomeElement;
  readonly ask: ComposableAsk;
}

function uniqueAsksById(asks: readonly ComposableAsk[]): ReadonlyMap<string, ComposableAsk> {
  const grouped = new Map<string, ComposableAsk[]>();
  for (const ask of asks) {
    const matches = grouped.get(ask.id) ?? [];
    matches.push(ask);
    grouped.set(ask.id, matches);
  }
  const unique = new Map<string, ComposableAsk>();
  for (const [id, matches] of grouped) {
    if (matches.length === 1 && matches[0] !== undefined) unique.set(id, matches[0]);
  }
  return unique;
}

function uniqueOutcomesByAskId(report: DraftBoard): ReadonlyMap<string, RoundOutcomeElement> {
  const grouped = new Map<string, RoundOutcomeElement[]>();
  for (const element of report.elements) {
    if (element.kind !== "round_outcome") continue;
    const matches = grouped.get(element.data.ask.ref) ?? [];
    matches.push(element);
    grouped.set(element.data.ask.ref, matches);
  }
  const unique = new Map<string, RoundOutcomeElement>();
  for (const [askId, matches] of grouped) {
    if (matches.length === 1 && matches[0] !== undefined) unique.set(askId, matches[0]);
  }
  return unique;
}

/** Report claims count only when both report and dispatch uniquely name the same ask. */
function addressedOutcomes(
  report: DraftBoard,
  dispatchedAsks: readonly ComposableAsk[],
): AddressedOutcome[] {
  const asks = uniqueAsksById(dispatchedAsks);
  const addressed: AddressedOutcome[] = [];
  for (const [askId, outcome] of uniqueOutcomesByAskId(report)) {
    if (outcome.data.status !== "addressed") continue;
    const ask = asks.get(askId);
    if (ask !== undefined) addressed.push({ outcome, ask });
  }
  return addressed;
}

function resolvedFindingRefs(
  addressed: readonly AddressedOutcome[],
  dispositions: Readonly<Record<string, FindingDisposition>>,
): FindingRef[] {
  const byKey = new Map<string, FindingRef>();
  for (const { ask } of addressed) {
    if (ask.finding !== undefined) byKey.set(findingRefKey(ask.finding), ask.finding);
  }
  for (const disposition of Object.values(dispositions)) {
    byKey.set(findingRefKey(disposition.finding), disposition.finding);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, finding]) => finding);
}

function findingsById(
  findings: readonly FindingElement[],
): ReadonlyMap<string, readonly FindingElement[]> {
  const grouped = new Map<string, FindingElement[]>();
  for (const finding of findings) {
    const matches = grouped.get(finding.id) ?? [];
    matches.push(finding);
    grouped.set(finding.id, matches);
  }
  return grouped;
}

function allFindingElements(board: DraftBoard): FindingElement[] {
  return board.elements.flatMap((element) => (element.kind === "finding" ? [element] : []));
}

/** Match only findings the served board can reach from a top-level section root. */
function reachableFindingElements(board: DraftBoard): FindingElement[] {
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  const nested = new Set<string>();
  for (const element of board.elements) {
    if (element.kind !== "section" && element.kind !== "order_step") continue;
    for (const child of element.data.children) nested.add(child);
  }

  const findings: FindingElement[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const element = byId.get(id);
    if (element === undefined) return;
    if (element.kind === "finding") {
      findings.push(element);
      return;
    }
    if (element.kind !== "section" && element.kind !== "order_step") return;
    for (const child of element.data.children) visit(child);
  };

  for (const element of board.elements) {
    if (element.kind === "section" && !nested.has(element.id)) visit(element.id);
  }
  return findings;
}

function codeRefsById(board: DraftBoard): ReadonlyMap<string, CodeRefElement> {
  const codeRefs = new Map<string, CodeRefElement>();
  for (const element of board.elements) {
    if (element.kind === "code_ref") codeRefs.set(element.id, element);
  }
  return codeRefs;
}

function normalizedConcern(concern: string): string {
  return concern.trim().replace(/\s+/g, " ");
}

/**
 * A deliberately narrow cross-generation identity. Patchset and element ids may change,
 * but the exact concern, severity, and every resolved source span must agree. Any missing
 * citation makes the identity unusable rather than inviting a text-only false match.
 */
function semanticIdentity(
  finding: FindingElement,
  codeRefs: ReadonlyMap<string, CodeRefElement>,
): string | undefined {
  const anchors: string[] = [];
  for (const codeId of finding.data.code) {
    const code = codeRefs.get(codeId);
    if (code === undefined) return undefined;
    anchors.push(
      JSON.stringify([
        code.data.path,
        code.data.side,
        code.data.start_line,
        code.data.end_line,
        code.data.symbol ?? null,
      ]),
    );
  }
  anchors.sort();
  return JSON.stringify([finding.data.severity, normalizedConcern(finding.data.concern), anchors]);
}

function findingsBySemanticIdentity(
  findings: readonly FindingElement[],
  codeRefs: ReadonlyMap<string, CodeRefElement>,
): ReadonlyMap<string, readonly FindingElement[]> {
  const grouped = new Map<string, FindingElement[]>();
  for (const finding of findings) {
    const identity = semanticIdentity(finding, codeRefs);
    if (identity === undefined) continue;
    const matches = grouped.get(identity) ?? [];
    matches.push(finding);
    grouped.set(identity, matches);
  }
  return grouped;
}

function resolveFindings(input: {
  readonly refs: readonly FindingRef[];
  readonly previous: DraftBoard | undefined;
  readonly previousGeneration: string;
  readonly previousBoardId: string | undefined;
  readonly current: DraftBoard;
}): FindingResolution[] {
  if (input.previous === undefined) {
    return input.refs.map((finding) => ({
      kind: "detached",
      finding,
      reason:
        finding.generation !== input.previousGeneration
          ? "source-generation-mismatch"
          : finding.boardId !== input.previousBoardId
            ? "source-board-mismatch"
            : "previous-finding-not-unique",
    }));
  }

  const previous = input.previous;
  const previousCodeRefs = codeRefsById(previous);
  const currentCodeRefs = codeRefsById(input.current);
  const previousReachable = reachableFindingElements(previous);
  const currentReachable = reachableFindingElements(input.current);
  const previousReachableSet = new Set(previousReachable);
  const currentReachableSet = new Set(currentReachable);
  const previousById = findingsById(allFindingElements(previous));
  const currentById = findingsById(allFindingElements(input.current));
  const previousBySemantic = findingsBySemanticIdentity(previousReachable, previousCodeRefs);
  const currentBySemantic = findingsBySemanticIdentity(currentReachable, currentCodeRefs);

  return input.refs.map((finding): FindingResolution => {
    if (finding.generation !== input.previousGeneration) {
      return { kind: "detached", finding, reason: "source-generation-mismatch" };
    }
    if (finding.boardId !== input.previousBoardId) {
      return { kind: "detached", finding, reason: "source-board-mismatch" };
    }

    const previousMatches = previousById.get(finding.findingId) ?? [];
    if (previousMatches.length !== 1 || previousMatches[0] === undefined) {
      return { kind: "detached", finding, reason: "previous-finding-not-unique" };
    }

    const identity = semanticIdentity(previousMatches[0], previousCodeRefs);
    const currentIdMatches = currentById.get(finding.findingId) ?? [];
    if (
      currentIdMatches.length === 1 &&
      currentIdMatches[0] !== undefined &&
      currentReachableSet.has(currentIdMatches[0])
    ) {
      const currentIdentity = semanticIdentity(currentIdMatches[0], currentCodeRefs);
      if (identity !== undefined && currentIdentity === identity) {
        return {
          kind: "reattached",
          finding,
          currentFindingId: currentIdMatches[0].id,
          match: "stable-id",
        };
      }
    }
    if (currentIdMatches.length > 1) {
      return {
        kind: "detached",
        finding,
        reason: "current-finding-not-uniquely-matched",
      };
    }

    const reachablePreviousSemanticMatches =
      identity === undefined ? [] : (previousBySemantic.get(identity) ?? []);
    const previousSemanticMatches = previousReachableSet.has(previousMatches[0])
      ? reachablePreviousSemanticMatches
      : [...reachablePreviousSemanticMatches, previousMatches[0]];
    const currentSemanticMatches =
      identity === undefined ? [] : (currentBySemantic.get(identity) ?? []);
    if (
      previousSemanticMatches.length !== 1 ||
      currentSemanticMatches.length !== 1 ||
      currentSemanticMatches[0] === undefined
    ) {
      return {
        kind: "detached",
        finding,
        reason: "current-finding-not-uniquely-matched",
      };
    }
    return {
      kind: "reattached",
      finding,
      currentFindingId: currentSemanticMatches[0].id,
      match: "unique-semantic",
    };
  });
}

function withoutResolvedFindings(
  board: DraftBoard,
  resolutions: readonly FindingResolution[],
): DraftBoard {
  const removed = new Set(
    resolutions.flatMap((resolution) =>
      resolution.kind === "reattached" ? [resolution.currentFindingId] : [],
    ),
  );
  return {
    ...board,
    elements: board.elements.map((element): DraftElement => {
      switch (element.kind) {
        case "section":
          return {
            ...element,
            data: {
              ...element.data,
              children: element.data.children.filter((child) => !removed.has(child)),
            },
          };
        case "order_step":
          return {
            ...element,
            data: {
              ...element.data,
              children: element.data.children.filter((child) => !removed.has(child)),
            },
          };
        default:
          return element;
      }
    }),
  };
}

export interface FindingDispositionMigrationInput {
  readonly findingDispositions: Readonly<Record<string, FindingDisposition>>;
  readonly successorGeneration: string;
  readonly successorBoardId: string;
  readonly resolutions: readonly FindingResolution[];
}

/** Clone reviewer dismissals onto uniquely reattached successor findings. */
export function findingDispositionMigrationEvents(
  input: FindingDispositionMigrationInput,
): AskEventBody[] {
  const known = new Set(Object.keys(input.findingDispositions));
  const events: AskEventBody[] = [];
  const reattached = input.resolutions
    .flatMap((resolution) => (resolution.kind === "reattached" ? [resolution] : []))
    .sort((left, right) => {
      const leftKey = findingRefKey(left.finding);
      const rightKey = findingRefKey(right.finding);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  for (const resolution of reattached) {
    const predecessorKey = findingRefKey(resolution.finding);
    if (input.findingDispositions[predecessorKey] === undefined) continue;

    const successor = {
      generation: input.successorGeneration,
      boardId: input.successorBoardId,
      findingId: resolution.currentFindingId,
    };
    const successorKey = findingRefKey(successor);
    if (known.has(successorKey)) continue;

    events.push({ kind: "finding-dismiss", finding: successor });
    known.add(successorKey);
  }

  return events;
}

function isAddressedHostElement(element: DraftElement): boolean {
  return element.id.startsWith(ROUND_ADDRESSED_NAMESPACE);
}

function roundNamespace(roundNumber: number): string {
  return `${ROUND_ADDRESSED_NAMESPACE}${roundNumber}:`;
}

function stripFreshAddressedChapters(board: DraftBoard): DraftElement[] {
  return board.elements.flatMap((element): DraftElement[] => {
    if (isAddressedHostElement(element)) return [];
    switch (element.kind) {
      case "section":
        return [
          {
            ...element,
            data: {
              ...element.data,
              children: element.data.children.filter(
                (child) => !child.startsWith(ROUND_ADDRESSED_NAMESPACE),
              ),
            },
          },
        ];
      case "order_step":
        return [
          {
            ...element,
            data: {
              ...element.data,
              children: element.data.children.filter(
                (child) => !child.startsWith(ROUND_ADDRESSED_NAMESPACE),
              ),
            },
          },
        ];
      default:
        return [element];
    }
  });
}

function priorAddressedChapters(
  previous: DraftBoard | undefined,
  currentRoundNamespace: string,
): DraftElement[] {
  if (previous === undefined) return [];
  return previous.elements.filter(
    (element) => isAddressedHostElement(element) && !element.id.startsWith(currentRoundNamespace),
  );
}

function addressedChapter(
  roundNumber: number,
  addressed: readonly AddressedOutcome[],
  report: DraftBoard,
): DraftElement[] {
  const namespace = roundNamespace(roundNumber);
  const children: string[] = [];
  const content: DraftElement[] = [];
  const reportById = new Map(report.elements.map((element) => [element.id, element]));

  addressed.forEach(({ outcome, ask }, index) => {
    const itemNamespace = `${namespace}${index}:`;
    const proseId = `${itemNamespace}prose`;
    const reportCodeRef =
      outcome.data.code_ref === undefined ? undefined : reportById.get(outcome.data.code_ref);
    const codeRef = reportCodeRef?.kind === "code_ref" ? reportCodeRef : undefined;
    children.push(proseId);
    content.push({
      id: proseId,
      kind: "prose",
      data: {
        author: HOST_AUTHOR,
        markdown:
          codeRef === undefined
            ? `**${ask.instruction}**\n\n${outcome.data.note}`
            : `**${ask.instruction}**`,
      },
    });

    if (codeRef === undefined) return;
    const codeRefId = `${itemNamespace}code-ref`;
    const annotationId = `${itemNamespace}annotation`;
    children.push(annotationId);
    content.push(
      {
        ...codeRef,
        id: codeRefId,
        data: { ...codeRef.data, author: HOST_AUTHOR },
      },
      {
        id: annotationId,
        kind: "annotation",
        data: { author: HOST_AUTHOR, code_ref: codeRefId, body: outcome.data.note },
      },
    );
  });

  return [
    {
      id: `${namespace}section`,
      kind: "section",
      data: {
        author: HOST_AUTHOR,
        title: `Round ${roundNumber} · Addressed`,
        children,
      },
    },
    ...content,
  ];
}

function composeSequence(
  input: ComposeFindingRoundInput,
  addressed: readonly AddressedOutcome[],
): DraftBoard {
  const namespace = roundNamespace(input.roundNumber);
  const latestChapter =
    addressed.length === 0 ? [] : addressedChapter(input.roundNumber, addressed, input.report);
  return {
    ...input.current,
    elements: [
      ...stripFreshAddressedChapters(input.current),
      ...priorAddressedChapters(input.previous, namespace),
      ...latestChapter,
    ],
  };
}

/** Apply the host-owned finding lifecycle for one freshly drafted lens board. */
export function composeFindingRound(input: ComposeFindingRoundInput): FindingRoundComposition {
  const addressed = addressedOutcomes(input.report, input.dispatchedAsks);
  switch (input.lens) {
    case "flagged": {
      const resolutions = resolveFindings({
        refs: resolvedFindingRefs(addressed, input.findingDispositions),
        previous: input.previous,
        previousGeneration: input.previousGeneration,
        previousBoardId: input.previousBoardId,
        current: input.current,
      });
      return { board: withoutResolvedFindings(input.current, resolutions), resolutions };
    }
    case "sequence":
      return { board: composeSequence(input, addressed), resolutions: [] };
    case "design":
    case "decisions":
    case "noise":
      return { board: input.current, resolutions: [] };
    default: {
      const exhaustive: never = input.lens;
      return exhaustive;
    }
  }
}
