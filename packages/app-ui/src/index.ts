import "./index.css";

export { ReviewWorkspace } from "./app";
// The board surface (C05, #489): the lens board document, element registry, fold
// grammar, quote highlights, and the lens/generation switchers. See `board/index.ts`.
export {
  type BoardKind,
  type ElementOf,
  type ElementRegistry,
  type ElementRenderer,
  GenerationSwitcher,
  LensBoardView,
  type LensBoardViewProps,
  LensSwitcher,
} from "./board";
// The collation draft (issue #101 / R40): the ordered, id-keyed editable draft — the
// forming destination. Reorder / merge / split need a list, not #17's path-keyed map.
// `collationItems` / `collationPayload` are the ordered outbound artifact the paper
// previews + signs. Now self-contained (B2, #489): the disposition shapes it once
// pulled from the deleted `authoring`/`logic` modules live here.
export type {
  CollationDraft,
  CollationItem,
  DispositionBatch,
  DispositionType,
  DispositionWrite,
} from "./canvas/collation";
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
// The chat dock (C07, #489): the persistent conversation dock mounted once into C3's
// layout slot. The `SessionTranscriptProvider` + projection types let a host supply the
// live session's transcript / trail / context figure / reviewId. See `chat/index.ts`.
export type {
  ChatDockModel,
  ChatTrail,
  CompactBoundaryRow,
  ContextWindow,
  DetachedThreadRef,
  DetachedThreadsRow,
  SessionTranscriptProjection,
  TranscriptRow,
  TurnRow,
  TurnStatus,
} from "./chat";
export {
  ChatDock,
  EMPTY_TRANSCRIPT,
  SessionTranscriptProvider,
  useSessionTranscript,
} from "./chat";
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
// The data seam's provider. A host mounts app-ui surfaces inside it and every read in
// the tree resolves through that one bridge; it is exported so a host outside this
// package (the desktop app, and its integration tests) can supply a real bridge to a
// single surface without standing up the whole router shell. Only the PROVIDER is
// public — `useCommand`/`useMutation` stay internal, so no consumer can invoke around
// the seam.
export { BridgeProvider } from "./data";
// The hand-off layer (C08, #489): the review's leaving surfaces — the exit FAB + derived pip,
// the mode-dispatched hand-off view, and the egress-return / draft types the exits speak. See
// `handoff/index.ts`.
export type {
  DraftedPr,
  EntryMode,
  ExitFabProps,
  HandoffViewProps,
  PostReceipt,
  ProposedVerdict,
  PrReceipt,
} from "./handoff";
export { ExitFab, HandoffView, modeHasExits, resolveEntryMode } from "./handoff";
// The Archived surface (C10 §9): its own main-surface route, enriched in place on
// C12's `project/archived-view.tsx`.
export { ArchivedView } from "./project/archived-view";
// The review layer (C4, #489): the shared machinery C5–C9 render — the one code
// surface, the multi-site evidence viewer, the one line-comment editor, the prose
// selection toolbar, the R45 markdown-subset renderer, reference chips, and the
// span-read citations seam. See `review/index.ts`.
export type {
  CodeBlockProps,
  CodeRef,
  DraftHandlers,
  LineCommentEditorProps,
  ReferenceChipProps,
  RichTextProps,
  SpanRead,
} from "./review";
export {
  AnchorReveal,
  CodeBlock,
  CodeTabs,
  LineCommentEditor,
  ProseSelectionLayer,
  ReferenceChip,
  RichText,
  useAskLog,
  useSpanRead,
} from "./review";
// The rounds surface (C09): the run route, report-as-greeting, ledger, and the rounds
// seam. The barrel (`rounds/index.ts`) is already the curated public list, so re-export
// it whole — the app shell binds the live `RoundsSourceProvider` through it (cluster 8).
export * from "./rounds";
// The router IS the running client now (C03 cutover): the desktop entries mount
// `RennetRouterApp` inside `ConnectionHost`, with the host-selected history.
export {
  browserHistory,
  hashHistory,
  memoryHistory,
  type RennetHistory,
  RennetRouterApp,
  type RennetRouterAppProps,
} from "./routes";
// The Settings takeover (C10): the route-driven page directory replacing the deleted
// one-file `components/settings-screen.tsx` (autopsy S2). See `settings/index.ts`.
export { SettingsScreen } from "./settings";
// The frame's command menu + the ONE global key owner (C11, autopsy S7). The key-layer
// API lets a later overlay (C5/C12) register on the same Escape priority stack; the
// entry builders + key-action catalogue stay module-private behind these.
export { CommandMenu, type KeyLayerHandler, KeyOwner, useKeyLayer } from "./shell";
export { useRennetStore } from "./store";
