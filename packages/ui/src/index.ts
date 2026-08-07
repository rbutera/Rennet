import "./styles.css";
import "./tokens.css";
import "./canvas.css";

export { RennetApp, ReviewWorkspace } from "./app";
export type {
  AuthoredResult,
  AuthoringAct,
  AuthoringTrace,
  DispositionBatch,
  DispositionDraft,
  Granularity,
  OrphanedDisposition,
} from "./canvas/authoring";
// Disposition authoring depth (issue #17): full-granularity authoring, the raw-draft
// batch, and the orphaned-disposition set. `DispositionDraft` is the #19 seam.
export {
  addToBatch,
  authorDisposition,
  batchPayload,
  batchPayloadDigest,
  batchViewModel,
  draftsFromAuthored,
  editDraftBody,
  editDraftType,
  orphanedDispositions,
  withdrawDraft,
} from "./canvas/authoring";
export type { CanvasFeedSource } from "./canvas/feed";
export { demoCanvases, demoDiff } from "./canvas/fixtures";
export type { ApprovalScope, DispositionWrite } from "./canvas/logic";
export type { CoverageMosaic, MosaicCell, ReadState, ViewEvent } from "./canvas/read-state";
export {
  coverageMosaic,
  dispositionsToViewEvents,
  foldReadState,
  nextUnread,
} from "./canvas/read-state";
export type { BatchDestination } from "./components/batch-view";
export { BatchView } from "./components/batch-view";
export { CoverageMosaicView } from "./components/coverage";
export type { GranularityContext } from "./components/granularity-author";
export { GranularityAuthor } from "./components/granularity-author";
export { OrphanTray } from "./components/orphan-tray";
export type { CanvasWorkspaceProps, DiffResolver } from "./components/workspace";
export { CanvasWorkspace } from "./components/workspace";
