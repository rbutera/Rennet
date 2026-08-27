import type { HostElement } from "@rennet/protocol";
import { createElement, type ReactNode } from "react";
import { RENDERERS } from "../board/kinds/renderers";
import { RoundOutcomeElement } from "../board/kinds/round-outcome";
import { assertExcludedKind, type BoardKind } from "../board/registry";

// ─────────────────────────────────────────────────────────────────────────────
// The round-report registry (C09 2.2) — reuse + WIDEN C5's element registry.
//
// A round report is a `LensBoard` (Reconciliation 3) whose items include
// `round_outcome`, the ONE kind excluded from every lens board (`BOARD_EXCLUDED_KINDS`).
// So the report can NOT render through the lens `BoardElement` (which throws loudly on
// `round_outcome`, the autopsy-S4 inversion). It dispatches through THIS registry
// instead — every lens renderer PLUS `round_outcome`, with the greeting prose reusing
// the existing `prose` renderer unchanged.
//
// Totality (the positive control, task 2.4): {@link ReportRegistry} is
// `Record<ReportKind, ReportRenderer>`, so {@link REPORT_RENDERERS} is a COMPILE ERROR
// unless it carries a renderer for EVERY report kind — omit `round_outcome` (or any
// kind) and the build fails, exactly as C5's `RENDERERS` map proves lens totality.
// `review_comment` stays out of the domain (the team-review surface renders it), and
// {@link ReportElement} narrows it off and ends in `assertExcludedKind`'s `assertNever`.
// ─────────────────────────────────────────────────────────────────────────────

/** The kinds a report board renders: every lens board kind PLUS `round_outcome`. */
export type ReportKind = BoardKind | "round_outcome";

/** A {@link HostElement} narrowed to one report kind — a report renderer's input. */
export type ReportElementOf<K extends ReportKind> = Extract<HostElement, { kind: K }>;

/** One per-kind report renderer: a component from a report kind's element to its DOM. */
export type ReportRenderer<K extends ReportKind = ReportKind> = (props: {
  element: ReportElementOf<K>;
}) => ReactNode;

/** The report registry: exactly one renderer per report kind. Record completeness is the
 *  totality proof — a report kind with no registered renderer is a compile error. */
export type ReportRegistry = { readonly [K in ReportKind]: ReportRenderer<K> };

/** C5's lens renderers, widened with `round_outcome`. For every lens kind
 *  `ElementRenderer<K>` and `ReportRenderer<K>` are the same type (both map
 *  `Extract<HostElement,{kind:K}>` → ReactNode), so the spread satisfies the wider
 *  Record; omit `round_outcome` and the assignment fails to typecheck (task 2.4). */
export const REPORT_RENDERERS: ReportRegistry = {
  ...RENDERERS,
  round_outcome: RoundOutcomeElement,
};

/**
 * Dispatch one report-board element through {@link REPORT_RENDERERS}. Unlike the lens
 * `BoardElement`, `round_outcome` renders here; `review_comment` is still out of the
 * report domain and throws loudly via `assertExcludedKind` (no silent null). The cast is
 * the same distributed-union escape hatch `Element` uses — the Record guarantees the
 * renderer and the element line up kind by kind.
 */
export function ReportElement({ element }: { readonly element: HostElement }) {
  if (element.kind === "review_comment") return assertExcludedKind(element.kind);
  const Renderer = REPORT_RENDERERS[element.kind] as ReportRenderer;
  return createElement(Renderer, { element });
}
