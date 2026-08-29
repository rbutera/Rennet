import { AnchorReveal } from "../../review";
import type { ElementOf } from "../registry";
import { toCodeRef } from "./element-context";

// `code_ref` (C05 3.2) — a citation into the captured patchset (code is never copied,
// #462). The element's attrs ARE the canonical CodeRef; it hydrates through C4's
// `AnchorReveal` → `useSpanRead` → `CodeBlock` (review/citations.ts). The daemon serves
// the span from the captured patch text; when it cannot, it says which absence it hit and
// that sentence is what renders. No new span-read path.

export function CodeRefElement({ element }: { readonly element: ElementOf<"code_ref"> }) {
  return (
    <div data-kind="code_ref">
      <AnchorReveal citations={[toCodeRef(element)]} />
    </div>
  );
}
