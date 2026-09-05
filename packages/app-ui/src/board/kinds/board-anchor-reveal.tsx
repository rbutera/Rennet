import type { CodeRef } from "@rennet/protocol";
import { AnchorReveal } from "../../review";
import { useCitationsOpenByDefault } from "./element-context";

// The board's `AnchorReveal`. Every board kind that reveals a cited span goes through
// here rather than calling `AnchorReveal` directly, so the "open on arrival" rule is
// decided in ONE place from the board's lens instead of seven call sites agreeing.

export function BoardAnchorReveal({ citations }: { readonly citations: readonly CodeRef[] }) {
  const openByDefault = useCitationsOpenByDefault();
  return <AnchorReveal citations={citations} defaultOpen={openByDefault} />;
}
