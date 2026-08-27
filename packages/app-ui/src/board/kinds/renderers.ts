import type { HostElement } from "@rennet/protocol";
import { createElement } from "react";
import { assertExcludedKind, Element, type ElementRegistry } from "../registry";
import { AnnotationElement } from "./annotation";
import { CalloutElement } from "./callout";
import { CodeRefElement } from "./code-ref";
import { DecisionElement } from "./decision";
import { useElements } from "./element-context";
import { FindingElement } from "./finding";
import { MessageElement } from "./message";
import { NoiseVerdictElement } from "./noise-verdict";
import { OrderStepElement } from "./order-step";
import { ProseElement } from "./prose";
import { RequirementElement } from "./requirement";
import { SectionElement } from "./section";

// ─────────────────────────────────────────────────────────────────────────────
// The concrete registry (C05 cluster 3) — one renderer per board kind, wired into the
// `Record<BoardKind, ElementRenderer>` the cluster-2 dispatch proves total. The
// annotation on {@link RENDERERS} is the FIRST totality proof from registry.ts: this
// literal is a compile error unless it carries a renderer for EVERY board kind (add a
// #462 kind, the map stops satisfying `ElementRegistry`, the build fails). No silent
// `default: return null` — the named replacement for the spike's autopsy-S4 defect.
// ─────────────────────────────────────────────────────────────────────────────

export const RENDERERS: ElementRegistry = {
  prose: ProseElement,
  callout: CalloutElement,
  annotation: AnnotationElement,
  code_ref: CodeRefElement,
  finding: FindingElement,
  decision: DecisionElement,
  requirement: RequirementElement,
  order_step: OrderStepElement,
  message: MessageElement,
  noise_verdict: NoiseVerdictElement,
  section: SectionElement,
};

/** Dispatch one board element through {@link RENDERERS}. The one entry point a
 *  composition (board-view, a section, an order step) renders an element with. The
 *  board-data boundary rejects excluded kinds, so this narrow is total at runtime —
 *  `assertExcludedKind` throws loudly rather than dropping an element silently. */
export function BoardElement({ element }: { readonly element: HostElement }) {
  if (element.kind === "round_outcome" || element.kind === "review_comment") {
    return assertExcludedKind(element.kind);
  }
  return createElement(Element, { registry: RENDERERS, element });
}

/** Resolve child element ids through the board pool and render each in order. Shared by
 *  the `section` and `order_step` renderers (and cluster 4's fold-grammar section). */
export function BoardChildren({ ids }: { readonly ids: readonly string[] }) {
  const children = useElements(ids);
  return children.map((element) => createElement(BoardElement, { key: element.id, element }));
}
