import { AnchorReveal } from "../../review";
import type { ElementOf } from "../registry";
import { toCodeRef } from "./element-context";

// `code_ref` (C05 3.2) — a citation into the captured patchset (code is never copied,
// #462). The element's attrs ARE the canonical CodeRef; it hydrates through C4's
// `AnchorReveal` → `useSpanRead` → `CodeBlock` (review/citations.ts), which surfaces
// the honest "not readable from the captured patchset" line while dispatch is unbound
// (Reconciliation 2). No new span-read path.

export function CodeRefElement({ element }: { readonly element: ElementOf<"code_ref"> }) {
  return (
    <div data-kind="code_ref">
      <AnchorReveal citations={[toCodeRef(element)]} />
    </div>
  );
}
