import "./index.css";

export { ReviewWorkspace } from "./app";
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
  useSpanRead,
} from "./review";
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
