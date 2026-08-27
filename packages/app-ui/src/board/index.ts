// The board surface (C05, #489) — the lens board rendered as a document: the element
// registry (one renderer per #462 kind, `assertNever`-total), the fold grammar, durable
// quote highlights, the lens/generation switchers, and the board-fetch seam. Mounted by
// `review-workspace-route.tsx`; re-exported from `app-ui/src/index.ts`.

// The public surface is exactly the packet's list: the document, the two switchers,
// and the registry types (C9 reuses and widens the registry). The board-fetch seam
// (`board-data.ts`), the element pool (`kinds/`), `Section`, and `LENS_LABEL` are
// module-private — every internal caller reaches them by deep path, and tests mount
// the seam/pool from those paths too, so nothing outside `board/` needs them.
export { LensBoardView, type LensBoardViewProps } from "./board-view";
export { GenerationSwitcher } from "./generation-switcher";
export { LensSwitcher } from "./lens-switcher";
export type {
  BoardKind,
  ElementOf,
  ElementRegistry,
  ElementRenderer,
} from "./registry";
