// The per-kind renderers (C05 cluster 3) — the public surface a composition mounts:
// the board element pool provider, the total registry, and the element/children
// dispatch. Individual kind components stay private; a board renders through these.

export { BoardElementsProvider, toCodeRef } from "./element-context";
export { BoardChildren, BoardElement, RENDERERS } from "./renderers";
