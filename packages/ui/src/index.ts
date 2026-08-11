import "./styles.css";
import "./tokens.css";
import "./canvas.css";

export { RennetApp, ReviewWorkspace } from "./app";
// The Ask surface (issue #139): per-thread routing memory + the ordered answer
// cards. Kept host-free so the routing law (no synthesis, remembered per thread)
// is unit-testable without a DOM.
export type { AskCard, AskModeByThread, AskOption } from "./canvas/ask";
export {
  ASK_OPTIONS,
  askCards,
  askedBoth,
  askModeForThread,
  DEFAULT_ASK_MODE,
  isAskAnswer,
  rememberAskMode,
} from "./canvas/ask";
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
// The inline conversation cluster (issue #36 — the review heart's private research
// chat): the thread/message model, the privacy boundary (promotion is the only path
// out), and the right-margin placement core (the diff never reflows). Fixture-driven
// here; live streaming is the deferred follow-up.
export type {
  ConversationAnchor,
  ConversationAnchorKind,
  ConversationThread,
  MessageAuthor,
  PromotionEvent,
  PromotionKind,
  ThreadLane,
  ThreadMessage,
} from "./canvas/conversation";
export {
  addMessage,
  answerInThread,
  askInThread,
  demoConversationThread,
  groupThreadsByAnchor,
  isPrivate,
  openThread,
  promoteMessage,
  THREAD_LANE,
  threadContentForPublish,
  threadMarginKey,
  threadRoute,
} from "./canvas/conversation";
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
// The hypothesis reading frame (issue #178): the human's committed prior, derived
// host-free from a `ReviewHypothesis` + its predicted-risk cross-check. Rendered
// BEFORE the lenses so the reviewer reads with an expectation. Open risks first.
export type { HypothesisFrame, HypothesisFrameRisk } from "./canvas/hypothesis";
export { buildHypothesisFrame } from "./canvas/hypothesis";
export type { ApprovalScope, DispositionWrite } from "./canvas/logic";
// The OpenSpec change view (#15): host-free derivation of a parsed `OpenSpecChange`
// into a review-anchored view model + task progress, plus `authorOpenSpecDisposition`
// — the seam that turns a disposition on any node into the existing `DispositionWrite`.
export type { OpenSpecTaskProgress, OpenSpecViewModel } from "./canvas/openspec";
export {
  authorOpenSpecDisposition,
  buildOpenSpecView,
  dispositionsForAnchor,
  openSpecAnchors,
} from "./canvas/openspec";
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
// The staging semantics (issue #109 — the review heart): the ink/blue material law
// (approve never publishes; request-change always does; comment/question default to
// the orchestrator and stage only sometimes), and the sign-off roll-up over the
// published (ink) subset.
export type { LaneCounts, PublishReviewType, StagingLane } from "./canvas/staging";
export {
  defaultLane,
  isPublished,
  isStageable,
  itemLane,
  laneCounts,
  localItems,
  publishedItems,
  publishReviewLabel,
  publishReviewType,
  stageItem,
} from "./canvas/staging";
export type { AskAnswersProps, AskControlProps } from "./components/ask";
export { AskAnswers, AskControl } from "./components/ask";
export { BatchView } from "./components/batch-view";
export { CollationDraftCanvas } from "./components/collation-draft-canvas";
// The inline conversation cluster UI (issue #36): the discuss verb (opens a thread),
// the private thread panel, and the right-margin column (a sibling of the diff, so
// the diff never reflows).
export type {
  ConversationClusterProps,
  ConversationMarginProps,
} from "./components/conversation-cluster";
export {
  ConversationCluster,
  ConversationMargin,
  DiscussControl,
  ThreadChip,
} from "./components/conversation-cluster";
export { CoverageMosaicView } from "./components/coverage";
export { DestinationFrame } from "./components/destination-frame";
export type {
  DispositionAnchorKind,
  DispositionClusterAnchor,
} from "./components/disposition-cluster";
export { DispositionCluster } from "./components/disposition-cluster";
export { FrontDoor } from "./components/front-door";
export type { GranularityContext } from "./components/granularity-author";
export { GranularityAuthor } from "./components/granularity-author";
export { HypothesisReadingFrame } from "./components/hypothesis";
export type { MarkIndexEntry } from "./components/mark-index";
export { MarkIndex } from "./components/mark-index";
// The OpenSpec change view (#15): the reviewable change document, reusing the
// DispositionCluster (the four verbs on every node) + AskControl/AskAnswers.
export type { OpenSpecAskProps, OpenSpecViewProps } from "./components/openspec";
export { OpenSpecView } from "./components/openspec";
export { OrphanTray } from "./components/orphan-tray";
export { PublishSheet } from "./components/publish-sheet";
export type { CanvasWorkspaceProps, DiffResolver } from "./components/workspace";
export { CanvasWorkspace } from "./components/workspace";
