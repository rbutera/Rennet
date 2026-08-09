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
  AttestationCounts,
  BatchDestination,
  DegradationKind,
  DestinationMode,
  DestinationVariant,
  LedgerEntry,
  PublishLedger,
} from "./canvas/destination";
export {
  bucketLedgerEntries,
  canSign,
  destinationVariant,
  draftsFromWrites,
  LEDGER_BUCKET_LABEL,
  LEDGER_BUCKET_ORDER,
  ledgerBlocksSign,
  resolveSign,
  stagedItems,
  stagedPayload,
} from "./canvas/destination";
export type { CanvasFeedSource } from "./canvas/feed";
export { demoCanvases, demoDiff } from "./canvas/fixtures";
export type { ApprovalScope, DispositionWrite } from "./canvas/logic";
// The publish target (issue #22): the two context-dependent outbound artifacts a
// review produces — the own-branch PR submission and the other-pr line-anchored
// review — both derived from the ONE collation draft. `publishTargetPayload` is the
// exact bytes the paper previews and signs ("what you see is what leaves", R33).
export type {
  LineAnchor,
  LineAnchors,
  PrSubmission,
  PrSubmissionContext,
  PublishContext,
  PublishTarget,
  ReviewComment,
} from "./canvas/publish";
export {
  composePrSubmission,
  composePrSubmissionBody,
  prSubmissionPayload,
  publishTarget,
  publishTargetPayload,
  refinedCount,
  reviewComments,
  reviewCommentsPayload,
  targetItemCount,
} from "./canvas/publish";
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
export { FrontDoor } from "./components/front-door";
export type { GranularityContext } from "./components/granularity-author";
export { GranularityAuthor } from "./components/granularity-author";
export type { MarkIndexEntry } from "./components/mark-index";
export { MarkIndex } from "./components/mark-index";
export { OrphanTray } from "./components/orphan-tray";
export { PublishSheet } from "./components/publish-sheet";
export type { CanvasWorkspaceProps, DiffResolver } from "./components/workspace";
export { CanvasWorkspace } from "./components/workspace";
