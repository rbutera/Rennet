import type { CodeRef, HostElement } from "@rennet/protocol";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { ElementOf } from "../registry";

// ─────────────────────────────────────────────────────────────────────────────
// The board element pool (C05 cluster 3). A #462 board is a flat element list where
// references are `element`-typed attributes (an element id): a finding's `code`, a
// decision's `evidence`, an annotation's `code_ref`, a section's `children`. A
// renderer that cites another element resolves the id through THIS context, never by
// walking a prop tree — the projection is denormalized and the pool is the join.
//
// The board patchset is derived here too: a `code_ref` element carries its own
// `patchset_id`, but prose citations (`path:line` inside markdown) resolve against a
// single board patchset — the first `code_ref`'s. board-view mounts the provider from
// the resolved `LensBoard`; cluster-3 tests mount it from a fixture element list.
// ─────────────────────────────────────────────────────────────────────────────

interface BoardElements {
  readonly index: ReadonlyMap<string, HostElement>;
  /** The review source/artifact navigation commands target. */
  readonly reviewId: string;
  /** The patchset prose citations resolve against — the first `code_ref`'s, or "". */
  readonly patchsetId: string;
  /** The board's generation — half the durable-highlight scope key (finding 2). */
  readonly generation: string;
  /** The board's id — the viewed-delta scope key (finding 3). */
  readonly boardId: string;
}

const BoardElementsContext = createContext<BoardElements>({
  index: new Map(),
  reviewId: "",
  patchsetId: "",
  generation: "",
  boardId: "",
});

/** Map a `code_ref` element to the canonical {@link CodeRef} (snake_case wire → camel).
 *  The `code_ref` kind's attrs ARE the canonical CodeRef field-for-field (schema.ts). */
export function toCodeRef(element: ElementOf<"code_ref">): CodeRef {
  const d = element.data;
  return {
    patchsetId: d.patchset_id,
    path: d.path,
    side: d.side,
    startLine: d.start_line,
    endLine: d.end_line,
    ...(d.symbol === undefined ? {} : { symbol: d.symbol }),
  };
}

/** Supplies the board's element pool + patchset + generation. Mounted by board-view
 *  (from the resolved board) and by cluster-3 tests (from a fixture element list). */
export function BoardElementsProvider({
  elements,
  reviewId = "",
  generation = "",
  boardId = "",
  children,
}: {
  readonly elements: readonly HostElement[];
  /** The review source/artifact navigation commands target. */
  readonly reviewId?: string;
  /** The board's generation — the durable-highlight scope key (finding 2). */
  readonly generation?: string;
  /** The board's id — the viewed-delta scope key (finding 3). */
  readonly boardId?: string;
  readonly children: ReactNode;
}) {
  const value = useMemo<BoardElements>(() => {
    const index = new Map(elements.map((el) => [el.id, el]));
    const firstCodeRef = elements.find((el) => el.kind === "code_ref");
    return {
      index,
      reviewId,
      patchsetId: firstCodeRef?.kind === "code_ref" ? firstCodeRef.data.patchset_id : "",
      generation,
      boardId,
    };
  }, [elements, reviewId, generation, boardId]);
  return <BoardElementsContext.Provider value={value}>{children}</BoardElementsContext.Provider>;
}

/** The review id for source/artifact navigation, or "" outside a review board. */
export function useBoardReviewId(): string {
  return useContext(BoardElementsContext).reviewId;
}

/** The patchset a board's prose citations resolve against. */
export function useBoardPatchsetId(): string {
  return useContext(BoardElementsContext).patchsetId;
}

/** The board generation — half the durable-highlight scope key (finding 2). */
export function useBoardGeneration(): string {
  return useContext(BoardElementsContext).generation;
}

/** The board id — the viewed-delta scope key (finding 3). */
export function useBoardId(): string {
  return useContext(BoardElementsContext).boardId;
}

/** Resolve an element id to its element, or `undefined` (a dangling ref renders nothing). */
export function useElement(id: string | undefined): HostElement | undefined {
  const { index } = useContext(BoardElementsContext);
  return id === undefined ? undefined : index.get(id);
}

/** The resolved board pool for structural projections that need to follow nested sections. */
export function useBoardElementIndex(): ReadonlyMap<string, HostElement> {
  return useContext(BoardElementsContext).index;
}

/** Resolve every id to its element, dropping any that dangle. */
export function useElements(ids: readonly string[]): HostElement[] {
  const { index } = useContext(BoardElementsContext);
  return ids.flatMap((id) => {
    const el = index.get(id);
    return el ? [el] : [];
  });
}

/** Resolve one `code_ref` id to its {@link CodeRef} (skips a non-code_ref / dangling id). */
export function useCodeRefOf(id: string | undefined): CodeRef | undefined {
  const el = useElement(id);
  return el?.kind === "code_ref" ? toCodeRef(el) : undefined;
}

/** Resolve a list of `code_ref` ids to their {@link CodeRef}s, in order. */
export function useCodeRefs(ids: readonly string[]): CodeRef[] {
  const els = useElements(ids);
  return els.flatMap((el) => (el.kind === "code_ref" ? [toCodeRef(el)] : []));
}
