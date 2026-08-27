import { AnchorReveal } from "../../review";
import type { ElementOf } from "../registry";
import { useCodeRefOf } from "./element-context";
import { BoardChildren } from "./renderers";

// `order_step` (C05 3.4) — one stop in a suggested reading order: a title, the code
// span it walks (a `code_ref` id → `AnchorReveal`), and child elements taught at the
// stop, rendered through the registry.

export function OrderStepElement({ element }: { readonly element: ElementOf<"order_step"> }) {
  const { title, span, children } = element.data;
  const spanRef = useCodeRefOf(span);
  return (
    <div data-kind="order_step" className="flex flex-col gap-1.5">
      <h4 className="font-semibold text-foreground text-sm leading-snug">{title}</h4>
      {spanRef && <AnchorReveal citations={[spanRef]} />}
      {children.length > 0 && <BoardChildren ids={children} />}
    </div>
  );
}
