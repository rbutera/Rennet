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
// The collation draft (issue #101 / R40): the ordered, id-keyed editable draft —
// the forming destination. Reorder / merge / split need a list, not #17's
// path-keyed map, so this is a new model that lifts FROM the batch. `collationItems`
// / `collationPayload` are the ordered outbound artifact the paper previews + signs.
export type { CollationDraft, CollationItem } from "./canvas/collation";
export {
  collationItems,
  collationPayload,
  draftFromBatch,
  effectiveBody,
  ingestWrites,
  mergeItems,
  moveItem,
  retypeItem,
  rewordItem,
  splitItem,
  withdrawItem,
  withdrawPath,
} from "./canvas/collation";
// The destination (issue #64): the persistent north the review stages toward, the
// two variants by mode, the staged vocabulary over #17's batch, and the sign gate.
export type {
  BatchDestination,
  DestinationMode,
  DestinationVariant,
  LedgerEntry,
  PublishLedger,
} from "./canvas/destination";
export {
  canSign,
  destinationVariant,
  draftsFromWrites,
  ledgerBlocksSign,
  resolveSign,
  stagedItems,
  stagedPayload,
} from "./canvas/destination";
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
// The inhabited CodeView (issue #77): the anchor↔row registrar (real file lines,
// sides, occurrence identity, span→row resolution) and L3 mark placement.
export type {
  BuildRegistryInput,
  HunkHeader,
  Mark,
  MarkIndexItem,
  MarkPlacement,
  OrphanMark,
  OrphanReason,
  PlacedMark,
  PlacementIndex,
  RegistryHunk,
  RegistryRow,
  RowKind,
  RowRegistry,
  RowResolution,
} from "./canvas/registrar";
export {
  buildRowRegistry,
  indexPlacements,
  markIndexItems,
  placeMarks,
  resolveAnchorToRows,
} from "./canvas/registrar";
export { BatchView } from "./components/batch-view";
export { CollationDraftCanvas } from "./components/collation-draft-canvas";
export { CoverageMosaicView } from "./components/coverage";
export { DestinationFrame } from "./components/destination-frame";
export type { GranularityContext } from "./components/granularity-author";
export { GranularityAuthor } from "./components/granularity-author";
export type { MarkIndexEntry } from "./components/mark-index";
export { MarkIndex } from "./components/mark-index";
export { OrphanTray } from "./components/orphan-tray";
export { PublishSheet } from "./components/publish-sheet";
export type { CanvasWorkspaceProps, DiffResolver } from "./components/workspace";
export { CanvasWorkspace } from "./components/workspace";
