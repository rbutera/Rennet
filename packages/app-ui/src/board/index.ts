// The board surface (C05, #489) — the lens board rendered as a document: the element
// registry (one renderer per #462 kind, `assertNever`-total), the fold grammar, durable
// quote highlights, the lens/generation switchers, and the board-fetch seam. Mounted by
// `review-workspace-route.tsx`; re-exported from `app-ui/src/index.ts`.

export {
  type BoardResolution,
  type BoardSource,
  BoardSourceProvider,
  type LensBoardEntry,
  resolveBoard,
  useBoardData,
  useLensBoards,
} from "./board-data";
export { LensBoardView, type LensBoardViewProps } from "./board-view";
export { GenerationSwitcher } from "./generation-switcher";
export { BoardElement, BoardElementsProvider } from "./kinds";
export { LENS_LABEL, LensSwitcher } from "./lens-switcher";
export type {
  BoardKind,
  ElementOf,
  ElementRegistry,
  ElementRenderer,
} from "./registry";
export { Section } from "./section";
