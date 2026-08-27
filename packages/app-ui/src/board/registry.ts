import type { HostElement, HostKind } from "@rennet/protocol";
import { createElement, type ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// The element registry (C05, Objective clause 1 / autopsy S4) — one renderer per
// #462 host kind, dispatched through a map with an `assertNever` totality proof.
//
// The spike's `lens-board.tsx` was a 325-line `switch` over element kinds ending in
// a silent `default: return null`: add a #462 kind and it vanished from the
// document with no error. This registry inverts that failure mode — forget to
// render a kind and the BUILD FAILS, not the document silently. Two totality proofs
// hold the line together:
//
//  1. {@link ElementRegistry} is `Record<BoardKind, ElementRenderer>` — a map
//     literal (cluster 3's `RENDERERS`, filled from `board/kinds/`) is a compile
//     error unless it carries a renderer for EVERY board kind.
//  2. {@link Element}'s dispatch narrows off the two kinds outside the registry
//     domain and proves that complement is exhaustive with `assertNever` — narrow
//     the domain (widen the exclusion) without handling the newly-excluded kind and
//     `assertNever` stops reaching `never`, breaking the typecheck.
//
// The renderers themselves land in cluster 3; this module is the dispatch
// mechanism and the type-level totality proof, no stub renderers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kinds NO lens board carries (Reconciliation 3): `round_outcome` is the
 * round-report board (C9, which reuses and widens this registry) and `review_comment`
 * is the human GitHub comment on the team-review surface (C7/C8). One runtime list so
 * the type below and the board-data boundary's rejection ({@link resolveBoard}, finding
 * 4) share a single source — a board containing one of these is invalid DATA, rejected
 * at the seam, never a silently-dropped element.
 */
export const BOARD_EXCLUDED_KINDS = ["round_outcome", "review_comment"] as const;
export type BoardExcludedKind = (typeof BOARD_EXCLUDED_KINDS)[number];

/**
 * The kinds the lens-board registry renders — every host kind EXCEPT
 * {@link BOARD_EXCLUDED_KINDS}. Excluding them from the domain keeps `assertNever`
 * totality honest without a stub renderer standing in for absent work.
 */
export type BoardKind = Exclude<HostKind, BoardExcludedKind>;

/** A {@link HostElement} narrowed to one board kind — a renderer's input. */
export type ElementOf<K extends BoardKind> = Extract<HostElement, { kind: K }>;

/** One per-kind renderer: a component from a kind's element to its DOM. Cluster 3
 *  writes one per kind under `board/kinds/` and registers it in {@link ElementRegistry}. */
export type ElementRenderer<K extends BoardKind = BoardKind> = (props: {
  element: ElementOf<K>;
}) => ReactNode;

/** The registry: exactly one renderer per board kind. Record completeness is the
 *  first totality proof — a board kind with no registered renderer is a compile error. */
export type ElementRegistry = { readonly [K in BoardKind]: ElementRenderer<K> };

/** Exhaustiveness guard: reaching it is a compile error, because `value` is `never`
 *  only when every case is accounted for. The named replacement for the spike's
 *  silent `default: return null` (autopsy S4). */
export function assertNever(value: never): never {
  throw new Error(`unrendered board kind: ${JSON.stringify(value)}`);
}

/**
 * Dispatch one board-kind element through the registry. The input is narrowed to
 * {@link ElementOf}`<BoardKind>` — an excluded kind cannot reach here, because the
 * board-data boundary ({@link resolveBoard}) rejects any board carrying one as invalid
 * data. So there is no runtime out-of-domain arm and no silent `return null`.
 *
 * The cast is the standard distributed-union escape hatch: `registry[kind]` is the
 * union of all `ElementRenderer<K>` and `element` the union of all `ElementOf<K>`,
 * which TS cannot prove line up member-for-member — but the `ElementRegistry` type
 * guarantees they do, kind by kind.
 */
export function Element({
  registry,
  element,
}: {
  readonly registry: ElementRegistry;
  readonly element: ElementOf<BoardKind>;
}): ReactNode {
  const Renderer = registry[element.kind] as ElementRenderer;
  return createElement(Renderer, { element });
}

/**
 * The loud replacement for the spike's silent `default: return null` (autopsy S4).
 * A board carrying an excluded kind is rejected at the board-data boundary, so this is
 * unreachable in a rendered board; if one ever slips past it THROWS rather than
 * vanishing. Casing both members and ending in `assertNever(kind)` proves the
 * complement is EXACTLY `{round_outcome, review_comment}`: widen the exclusion in
 * {@link BoardKind} without adding the matching case here and `kind` in the default arm
 * is no longer `never`, so the typecheck fails (the positive control, task 2.2).
 */
export function assertExcludedKind(kind: BoardExcludedKind): never {
  switch (kind) {
    case "round_outcome": // → C9's round report (reuses this registry)
    case "review_comment": // → C7/C8's team-review surface
      throw new Error(`board kind "${kind}" does not render on a lens board`);
    default:
      return assertNever(kind);
  }
}
