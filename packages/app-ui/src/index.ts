import "./index.css";

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
// out), and the right-margin placement core (the diff never reflows). The harness
// answers are now LIVE (see `ConversationHost` below) over the real `review.ask`
// boundary; `buildConversationQuestion` is the pure carrier that folds the anchor +
// the conversation so far into the stateless turn.
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
  buildConversationQuestion,
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
  RegistryOccurrence,
  RegistryRow,
  RowKind,
  RowRegistry,
  RowResolution,
  SpanAnchorResult,
} from "./canvas/registrar";
export {
  buildRowRegistry,
  indexPlacements,
  markIndexItems,
  placeMarks,
  resolveAnchorToRows,
  spanAnchorForRows,
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
// The connections surface (issue #381): the shared daemon-attachment shell both the
// desktop renderer and the served browser tab mount. Transport-agnostic — the shell
// injects the bridge factory, so `ui` never imports a client package.
export type {
  BridgeFactory,
  ConnectDaemonForPath,
  Connection,
  ConnectionFactory,
  ConnectionHostProps,
  ConnectionState,
  ConnectionStatus,
  ConnectionTarget,
  DaemonResolution,
} from "./components/connection-host";
export { ConnectionHost } from "./components/connection-host";
// The context-composition inspector: Rennet's deterministic, gate-free assembly manifest.
export { ContextManifestPanel } from "./components/context-manifest-panel";
export { CoverageMosaicView } from "./components/coverage";
// The in-app directory browser (source-aware project selection, task 5): fed by
// `fs.listDir` so browsing works over a remote/WSL source with no native dialog.
export { DirectoryBrowser } from "./components/directory-browser";
export { FrontDoor } from "./components/front-door";
export { SettingsScreen } from "./components/settings-screen";
