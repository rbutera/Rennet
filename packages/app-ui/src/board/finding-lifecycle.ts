import {
  type AskProjection,
  type FindingRef,
  findingRefKey,
  type HostElement,
  type LensBoard,
} from "@rennet/protocol";

type FindingElement = Extract<HostElement, { readonly kind: "finding" }>;
type FindingStatus = FindingElement["data"]["status"];

export interface FindingLifecycleSource {
  readonly stagedAsks: AskProjection["stagedAsks"];
  readonly findingDispositions: AskProjection["findingDispositions"];
}

export interface FindingLifecycle {
  readonly ref: FindingRef;
  readonly askId: string;
  readonly requested: boolean;
  readonly dismissedByReviewer: boolean;
  readonly status: FindingStatus;
  readonly open: boolean;
}

export function findingRef(generation: string, boardId: string, findingId: string): FindingRef {
  return { generation, boardId, findingId };
}

export function findingAskId(ref: FindingRef): string {
  return `finding:${findingRefKey(ref)}`;
}

function hasStagedRequest(source: FindingLifecycleSource, ref: FindingRef): boolean {
  const ask = source.stagedAsks[findingAskId(ref)];
  return ask?.finding !== undefined && findingRefKey(ask.finding) === findingRefKey(ref);
}

export function findingLifecycle(
  element: FindingElement,
  generation: string,
  boardId: string,
  source: FindingLifecycleSource,
): FindingLifecycle {
  const ref = findingRef(generation, boardId, element.id);
  const dismissedByReviewer = source.findingDispositions[findingRefKey(ref)] !== undefined;
  const requested = hasStagedRequest(source, ref);
  const status: FindingStatus = dismissedByReviewer ? "dismissed" : element.data.status;
  return {
    ref,
    askId: findingAskId(ref),
    requested,
    dismissedByReviewer,
    status,
    open: status === "open" && !requested,
  };
}

export function countOpenFindings(board: LensBoard, source: FindingLifecycleSource): number {
  const index = new Map(board.elements.map((element) => [element.id, element]));
  const visited = new Set<string>();
  let count = 0;

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const element = index.get(id);
    if (element === undefined) return;
    if (element.kind === "finding") {
      if (findingLifecycle(element, board.generation, board.boardId, source).open) count += 1;
      return;
    }
    if (element.kind === "section" || element.kind === "order_step") {
      for (const child of element.data.children) visit(child);
    }
  };

  for (const entry of board.sections) {
    const root = index.get(entry.ref);
    if (root?.kind === "section") visit(entry.ref);
  }
  return count;
}
