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
 * The kinds the lens-board registry renders — every host kind EXCEPT the two no
 * lens board carries (Reconciliation 3): `round_outcome` is the round-report board
 * (C9, which reuses and widens this registry) and `review_comment` is the human
 * GitHub comment on the team-review surface (C7/C8). Excluding them from the domain
 * keeps `assertNever` totality honest without a stub renderer standing in for
 * absent work.
 */
export type BoardKind = Exclude<HostKind, "round_outcome" | "review_comment">;

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
 * Dispatch one {@link HostElement} through the registry. Looks up `element.kind`,
 * renders through the map, and routes the two out-of-domain kinds to
 * {@link renderOutsideRegistry} (whose `assertNever` is the second totality proof).
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
  readonly element: HostElement;
}): ReactNode {
  const { kind } = element;
  if (kind === "round_outcome" || kind === "review_comment") {
    return renderOutsideRegistry(kind);
  }
  const Renderer = registry[kind] as ElementRenderer;
  return createElement(Renderer, { element: element as ElementOf<BoardKind> });
}

/**
 * The complement of the registry domain within `HostKind`. Casing both members and
 * ending in `assertNever(kind)` proves that complement is EXACTLY
 * `{round_outcome, review_comment}`: widen the exclusion in {@link BoardKind}
 * without adding the matching case here and `kind` in the default arm is no longer
 * `never`, so the typecheck fails (the positive control, task 2.2).
 */
function renderOutsideRegistry(kind: Exclude<HostKind, BoardKind>): null {
  switch (kind) {
    case "round_outcome": // → C9's round report (reuses this registry)
    case "review_comment": // → C7/C8's team-review surface
      return null;
    default:
      return assertNever(kind);
  }
}
