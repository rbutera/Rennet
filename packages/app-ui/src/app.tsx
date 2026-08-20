import {
  type AppearanceScheme,
  type CommandInput,
  openSpecRequirementCoverageKey,
  type Project,
  type ProjectDetail as ProjectDetailData,
  type RennetBridge,
} from "@rennet/protocol";
import type {
  CanvasAngle,
  ContextManifest,
  DecisionsRunStatus,
  ElementDiffs,
  FlaggedReview,
  NoiseReview,
  OpenSpecChange,
  OpenSpecCoverage,
  Review,
  ReviewEngine,
  ReviewNarration,
} from "@rennet/types";
import { CANVAS_ANGLES } from "@rennet/types";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { type AngleRailRow, activePatchset, type DiffFocus, SECONDARY_BUTTON } from "./app/shared";
import {
  type CollationDraft,
  type CollationItem,
  clearRefined,
  effectiveBody,
  ingestWrites,
  itemRefineSignature,
  setRefined,
  withdrawPath,
} from "./canvas/collation";
import {
  type ConversationAnchor,
  chunkAnchorKey,
  type DiscussRequest,
} from "./canvas/conversation";
import { type DestinationMode, destinationVariant, type PublishLedger } from "./canvas/destination";
import { flaggedForPatchset } from "./canvas/flagged";
import { type CanvasSet, loadCanvases } from "./canvas/load";
import { type DispositionWrite, withoutProposal, zoomReducer } from "./canvas/logic";
import type { OpenSpecCoverageIndex } from "./canvas/openspec";
import {
  deriveReviewEvent,
  handoffDispositions,
  type PublishContext,
  previewPublishTarget,
  previewTargetLabel,
  publishTarget,
  publishTargetPayload,
  reviewComments,
  reviewCommentsPayload,
} from "./canvas/publish";
import { buildRowRegistry, type RegistryRow } from "./canvas/registrar";
import { publishedItems } from "./canvas/staging";
import { createViewStore, useViewStore } from "./canvas/store";
import {
  buildCommands,
  type Command,
  type CommandContext,
  chordFromEvent,
  commandFromCatalogue,
  type KeybindingOverrides,
  matchKeybinding,
  type Screen,
} from "./command/commands";
import { RennetBrandMark } from "./components/brand-mark";
import { Breadcrumb } from "./components/breadcrumb";
import {
  CollationDraftCanvas,
  type PrDraftState,
  type PrDraftValues,
  type RefineItemState,
} from "./components/collation-draft-canvas";
import { CommandPalette } from "./components/command-palette";
import { ContextManifestPanel } from "./components/context-manifest-panel";
import { ContextMapView } from "./components/context-map-view";
import { ConversationPanel } from "./components/conversation-panel";
import { DeltaAccountPanel } from "./components/delta-account-panel";
import { DestinationFrame } from "./components/destination-frame";
import { FrontDoor } from "./components/front-door";
import { HandoffPaper, type HandoffRunState } from "./components/handoff-paper";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FileDiffIcon,
  FolderIcon,
  LayersIcon,
  TriangleIcon,
} from "./components/icons";
import { ANGLE_LABELS } from "./components/lens";
import { PrWorktreeStatus } from "./components/pr-worktree-status";
import { ProjectDetail } from "./components/project-detail";
import { type PublishOutcome, PublishSheet } from "./components/publish-sheet";
import { SettingsScreen } from "./components/settings-screen";
import {
  ChromeMark,
  ChromeMenu,
  UpdateReadyPrompt,
  useUpdateReady,
} from "./components/update-ready";
import { CanvasWorkspace } from "./components/workspace";
import { runBatched } from "./concurrency";
import {
  ascendTo as ascendNavigationTo,
  crumb as deriveCrumb,
  discardTip as discardNavigationTip,
  NAV_HISTORY_LEGACY_KEY,
  NAV_HISTORY_STORAGE_KEY,
  navHistoryReducer,
  back as navigateBack,
  forward as navigateForward,
  type PersistedNavState,
  parse as parseNavigation,
  push as pushSurface,
  type RecentSurface,
  recordRecent,
  type Surface,
  type SurfaceLabels,
  serialize as serializeNavigation,
  surfaceIdentity,
} from "./nav/history";
import type { SmartRow } from "./project/smart-list";

/**
 * Apply the fan-out writes from an approve act to the local canvases (the demo
 * shell's optimistic L2). In the real product the engine returns the updated
 * canvas over the change feed; here the local set stands in until that wiring
 * lands. Dispositions are keyed by path, shared across the angles' substrate.
 */
function applyWrites(canvases: CanvasSet, writes: DispositionWrite[]): CanvasSet {
  const next = { ...canvases };
  for (const angle of Object.keys(next) as CanvasAngle[]) {
    const canvas = next[angle];
    const dispositions = [...canvas.layers.disposition.dispositions];
    for (const write of writes) {
      const disposition = {
        anchor: { path: write.path, contentDigest: "local" },
        type: write.type,
        body: write.body,
      };
      const existing = dispositions.findIndex((d) => d.anchor.path === write.path);
      if (existing >= 0) dispositions[existing] = disposition;
      else dispositions.push(disposition);
    }
    next[angle] = {
      ...canvas,
      layers: { ...canvas.layers, disposition: { dispositions } },
    };
  }
  return next;
}

/**
 * Resolve an adjudicated proposal off every canvas (the demo shell's optimistic
 * L3). Accept has already produced its L2 via `onDispositions`; both accept and
 * dismiss then remove the proposal so it does not linger or get re-adjudicated.
 */
function resolveProposal(canvases: CanvasSet, proposalId: string): CanvasSet {
  const next = { ...canvases };
  for (const angle of Object.keys(next) as CanvasAngle[]) {
    next[angle] = withoutProposal(next[angle], proposalId);
  }
  return next;
}

const ANGLE_STATE_TEXT: Record<Exclude<AngleRailRow["state"], "ran">, string> = {
  pending: "Pending",
  running: "Running",
  failed: "Failed",
  unavailable: "Unavailable",
};

function railCount(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Derive the Angles rail from the SAME state the Canvases view renders from —
 * the five real canvas angles, never the old fictional six. Honesty rules:
 * a count appears ONLY when loaded data carries it; the flagged and noise rows
 * read their own fetch results (their lenses are fed by those fetches, not the
 * canvas analysis layer, and those fetches fire on review open — so `running`
 * is literally true for them while undefined); the other three angles read the
 * loaded canvas set, whose analysis elements are what their lenses place.
 */
function angleRailRows(input: {
  repositoryPresent: boolean;
  loadFailed: boolean;
  canvases: CanvasSet | null;
  decisionsRun: DecisionsRunStatus | undefined;
  flagged: FlaggedReview | undefined;
  noise: NoiseReview | undefined;
}): AngleRailRow[] {
  const { repositoryPresent, loadFailed, canvases, decisionsRun, flagged, noise } = input;
  // A gone repository (#324/D6) makes the WHOLE live review unavailable — all five
  // rows, not just the canvas-fed three: none of the fetches fire against a path
  // that isn't there, so "Running" would be a lie for flagged/noise too.
  if (!repositoryPresent) {
    return CANVAS_ANGLES.map((angle) => ({
      angle,
      label: ANGLE_LABELS[angle],
      state: "unavailable" as const,
    }));
  }
  const fromCanvas = (angle: CanvasAngle): Pick<AngleRailRow, "state" | "detail"> => {
    // The Decisions runner can fail while the rest of the set lands (#137/#160):
    // say so, never an element count that dresses a crashed pass as a run.
    if (angle === "decisions" && decisionsRun?.status === "failed") return { state: "failed" };
    if (canvases) {
      return {
        state: "ran",
        detail: railCount(canvases[angle].layers.analysis.elements.length, "element"),
      };
    }
    return { state: loadFailed ? "failed" : "pending" };
  };
  const flaggedRow = (): Pick<AngleRailRow, "state" | "detail"> =>
    flagged === undefined
      ? { state: "running" }
      : flagged.status === "failed"
        ? { state: "failed" }
        : { state: "ran", detail: railCount(flagged.findings.length, "finding") };
  const noiseRow = (): Pick<AngleRailRow, "state" | "detail"> =>
    noise === undefined
      ? { state: "running" }
      : noise.status === "failed"
        ? { state: "failed" }
        : { state: "ran", detail: railCount(noise.groups.length, "group") };
  return CANVAS_ANGLES.map((angle) => ({
    angle,
    label: ANGLE_LABELS[angle],
    ...(angle === "flagged" ? flaggedRow() : angle === "noise" ? noiseRow() : fromCanvas(angle)),
  }));
}

/** Max concurrent refine turns fired by "Refine all" (#19) — bounds the model
 *  subprocess fan-out on a large draft without the deferred budget machinery. */
const REFINE_CONCURRENCY = 3;

function rowIsFocused(row: RegistryRow, focus: DiffFocus | undefined): boolean {
  if (focus === undefined || row.fileLine === null || row.kind !== "content") return false;
  const endLine = focus.span.endLine ?? focus.span.startLine;
  if (row.fileLine < focus.span.startLine || row.fileLine > endLine) return false;
  if (focus.side === "deletions") return row.side === "deletions";
  if (focus.side === "additions") return row.side === "additions";
  return row.side !== "deletions";
}

// The changed-file status chip's gold/green/red fill, by git status. Decisions and
// accent are one hue now, so a modified file's square is the gold fill (brief).
const STATUS_CHIP: Record<string, string> = {
  added: "bg-add text-add-ink",
  modified: "bg-accent-fill text-accent-ink",
  deleted: "bg-del text-del-ink",
  renamed: "bg-accent-soft text-accent",
};

export function ReviewWorkspace({
  review,
  selectedPath,
  focus,
  angleRail,
  outlineFallback,
  onOpenAngle,
  onSelectPath,
  onSetRead,
  onRegenerate,
}: {
  review: Review;
  selectedPath?: string;
  focus?: DiffFocus;
  /** The Angles rail, derived from the real canvas/fetch state (`angleRailRows`). */
  angleRail: readonly AngleRailRow[];
  /** True when the loaded set is the mechanical outline, not AI findings (#260). */
  outlineFallback: boolean;
  /** Open the Canvases view on the given angle — the rail's rows navigate there. */
  onOpenAngle(angle: CanvasAngle): void;
  onSelectPath(path: string): void;
  onSetRead(path: string, read: boolean): void;
  onRegenerate(): void;
}) {
  const patchset = activePatchset(review);
  const selected = patchset.files.find((file) => file.path === selectedPath) ?? patchset.files[0];
  const diffRows = useMemo(
    () => buildRowRegistry({ diff: selected?.patch ?? "" }).rows,
    [selected?.patch],
  );
  const diffRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (focus === undefined || focus.path !== selected?.path) return;
    const first = diffRef.current?.querySelector<HTMLElement>('[data-delta-focus="true"]');
    first?.focus({ preventScroll: true });
    first?.scrollIntoView?.({ block: "center" });
  }, [focus, selected?.path]);
  // Read-state is derived: a file is "read" iff it carries a disposition.
  const readPaths = new Set(review.dispositions.map((disposition) => disposition.anchor.path));
  const percentage = patchset.files.length
    ? Math.round((readPaths.size / patchset.files.length) * 100)
    : 100;

  return (
    <div className="app-shell flex min-h-screen flex-col bg-canvas text-ink">
      <header className="topbar flex h-14 items-center justify-between gap-4 border-b border-line bg-canvas px-6">
        <div className="topbar-title flex items-center gap-3">
          <ChromeMark
            size={16}
            className="topbar-mark grid h-[30px] flex-none place-items-center rounded-control border border-accent-line bg-accent-soft px-2"
          />
          <div>
            <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              LOCAL REVIEW
            </p>
            <h1 className="m-0 font-display text-xl font-medium text-ink">
              {patchset.repository.root.split("/").at(-1)}
            </h1>
          </div>
        </div>
        <div
          className="provenance flex items-center gap-2.5 text-sm text-ink-faint"
          title={patchset.id}
        >
          <span>{patchset.repository.baseRef}</span>
          <code className="rounded-micro bg-raised px-2 py-1 font-mono text-ink">
            {patchset.repository.baseOid.slice(0, 8)}
          </code>
          <ArrowRightIcon size={12} className="provenance-arrow text-ink-faint opacity-70" />
          <code className="rounded-micro bg-raised px-2 py-1 font-mono text-ink">
            {patchset.repository.headOid.slice(0, 8)}
          </code>
        </div>
      </header>

      {review.status === "invalid" ? (
        <section
          className="invalid-banner flex items-center justify-between gap-5 border-b border-accent-line bg-accent-surface px-6 py-3 text-ink"
          role="status"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <strong>Your code changed.</strong>
            <span>Pinned to the previous patchset until you regenerate.</span>
          </div>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-2 rounded-control bg-accent-fill px-3.5 py-2 font-semibold text-accent-ink"
            onClick={onRegenerate}
          >
            Regenerate affected review
          </button>
        </section>
      ) : null}

      <section
        className="progress-row grid h-[34px] grid-cols-[58px_1fr_58px] items-center gap-2.5 border-b border-line bg-canvas px-6 text-xs text-ink-faint"
        aria-label={`${percentage}% of changed files read`}
      >
        <span>{readPaths.size} read</span>
        <div className="progress-track h-[3px] overflow-hidden rounded-control bg-raised">
          <span className="block h-full bg-accent-fill" style={{ width: `${percentage}%` }} />
        </div>
        <span>{patchset.files.length} files</span>
      </section>

      <main className="review-grid grid min-h-0 flex-1 grid-cols-[260px_minmax(440px,1fr)_240px]">
        <aside
          className="file-panel min-w-0 border-r border-line bg-surface"
          aria-label="Changed files"
        >
          <div className="panel-title flex h-11 items-center gap-2 px-4 pt-4 text-2xs font-semibold uppercase tracking-wide text-ink-soft">
            Changes
          </div>
          {patchset.files.length === 0 ? (
            <p className="muted px-4 text-sm leading-relaxed text-ink-faint">
              No changes against {patchset.repository.baseRef}.
            </p>
          ) : (
            patchset.files.map((file) => {
              const read = readPaths.has(file.path);
              return (
                <button
                  type="button"
                  className={`file-row grid h-10 w-full grid-cols-[22px_minmax(0,1fr)_12px] items-center gap-2 border-l-2 border-transparent text-left text-ink-soft hover:bg-raised ${selected?.path === file.path ? "selected border-accent bg-raised text-ink" : ""}`}
                  key={file.path}
                  onClick={() => onSelectPath(file.path)}
                >
                  <span
                    className={`status status-${file.status} grid h-[17px] w-[18px] place-items-center rounded-micro font-mono text-2xs font-bold ${STATUS_CHIP[file.status] ?? "bg-raised text-ink-soft"}`}
                  >
                    {file.status[0]?.toUpperCase()}
                  </span>
                  <span className="file-name overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs">
                    {file.path}
                  </span>
                  <span
                    className={`read-dot size-[7px] rounded-full border border-line-strong ${read ? "is-read border-accent bg-accent" : ""}`}
                    aria-hidden="true"
                  />
                </button>
              );
            })
          )}
        </aside>

        <section className="diff-panel flex min-w-0 flex-col bg-code">
          <div className="diff-toolbar flex h-11 flex-none items-center justify-between gap-4 border-b border-line bg-canvas px-3.5">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <strong className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs font-semibold text-ink">
                {selected?.path ?? "No changed file selected"}
              </strong>
              {selected ? (
                <span className="whitespace-nowrap text-xs text-ink-faint">
                  +{selected.additions ?? "–"} −{selected.deletions ?? "–"}
                </span>
              ) : null}
            </div>
            {selected ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() => onSetRead(selected.path, !readPaths.has(selected.path))}
              >
                {readPaths.has(selected.path) ? "Mark unread" : "Mark read"}
              </button>
            ) : null}
          </div>
          <pre
            className="diff m-0 flex-1 overflow-auto whitespace-pre px-[18px] pt-4 pb-10 font-mono text-sm leading-relaxed text-ink-soft [tab-size:2]"
            ref={diffRef}
          >
            {selected
              ? diffRows.map((row, index) => {
                  const focused = focus?.path === selected.path && rowIsFocused(row, focus);
                  return (
                    <span
                      key={row.rawIndex}
                      className={`diff-line${focused ? " is-delta-focus bg-accent-soft text-ink" : ""}`}
                      data-delta-focus={focused ? "true" : undefined}
                      data-file-line={row.fileLine ?? undefined}
                      data-side={row.side ?? undefined}
                      tabIndex={focused ? -1 : undefined}
                    >
                      {row.text}
                      {index < diffRows.length - 1 ? "\n" : ""}
                    </span>
                  );
                })
              : "There is no diff to display."}
          </pre>
        </section>

        <aside
          className="angle-panel min-w-0 border-l border-line bg-surface pb-5"
          aria-label="Review angles"
        >
          <div className="panel-title flex h-11 items-center gap-2 px-4 pt-4 text-2xs font-semibold uppercase tracking-wide text-ink-soft">
            Angles
          </div>
          {/* The loud outline honesty travels with the data (real-AI-default): when
              the loaded set is the deterministic mechanical outline, the counts below
              are diff STRUCTURE, and the rail says so — never passing them off as AI
              findings. The Canvases view carries the full banner + retry. */}
          {outlineFallback ? (
            <p className="muted px-4 text-sm leading-relaxed text-ink-faint">
              Structural outline — not AI findings.
            </p>
          ) : null}
          {/* Each row is the REAL state of that canvas angle (critique P2), and a
              row navigates to its canvas lens — the plumbing the Canvases view
              already exposes (`setAngle` + the view toggle), no new machinery. */}
          {angleRail.map((row) => (
            <button
              type="button"
              className="angle-row mx-3 flex h-9 w-[calc(100%-24px)] cursor-pointer items-center justify-between border-b border-line text-left text-sm text-ink-soft hover:text-ink"
              key={row.angle}
              onClick={() => onOpenAngle(row.angle)}
            >
              <span>{row.label}</span>
              <span
                className={`angle-state text-2xs uppercase tracking-wide text-ink-faint${row.state === "ran" ? " is-ran text-ink-soft" : ""}`}
              >
                {row.state === "ran" ? row.detail : ANGLE_STATE_TEXT[row.state]}
              </span>
            </button>
          ))}
          <div className="snapshot-card mx-3 my-4 grid gap-2 rounded-control border border-line bg-raised p-3">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">PATCHSET</span>
            <code className="font-mono text-sm text-accent">{patchset.id.slice(0, 12)}</code>
            <small className="leading-snug text-ink-faint">
              {patchset.truncated
                ? `Showing a capped view of ${patchset.byteLength.toLocaleString()} bytes`
                : `${patchset.byteLength.toLocaleString()} captured bytes`}
            </small>
          </div>
        </aside>
      </main>
    </div>
  );
}

/**
 * The loud, honest copy for the mechanical-outline fallback (real-AI-default).
 * `engine.aiReview` is false when the model phase did not complete — no model
 * installed, or the invocation budget refused it (#260) — so the title always
 * says plainly that the user is NOT looking at a full AI review, and names the
 * real cause (missing CLI vs spent budget). The outline is real diff STRUCTURE,
 * never AI findings.
 */
function mechanicalFallbackTitle(engine: ReviewEngine): string {
  // `aiReview` is false for exactly two reasons: no model was available, or the
  // model-invocation budget refused (#260). If ANY model is installed, the cause
  // was the budget, so name it — never blame a missing CLI that is right there.
  return engine.claudeAvailable || engine.codexAvailable
    ? "Not a full AI review — it hit the model-invocation budget. Showing a structural outline."
    : "Couldn't find your Claude CLI — this is a basic structural outline, not an AI review.";
}

function mechanicalFallbackDetail(engine: ReviewEngine): string {
  if (!engine.claudeAvailable && !engine.codexAvailable) {
    return "Install the Claude CLI (or Codex) and retry to get the real AI review of this diff.";
  }
  // A model was available but the review's invocation budget was spent — the diff
  // was over budget pre-flight, or retries exhausted the shared ceiling mid-review
  // (#260) — so parts of what's on screen are the diff's structure, not findings.
  return "This review's model-invocation budget was spent before it finished, so parts of what you see are the diff's structure, not AI findings.";
}

// Read the persisted navigation blob (#324/#297): the v3 stack + future + recents,
// falling back to the pre-stack v2 key so an upgrade keeps the user's recents. A
// bad/absent blob degrades to the clean default (no migration ceremony).
function readStoredNav(): PersistedNavState {
  try {
    const raw =
      globalThis.localStorage?.getItem(NAV_HISTORY_STORAGE_KEY) ??
      globalThis.localStorage?.getItem(NAV_HISTORY_LEGACY_KEY);
    return parseNavigation(raw);
  } catch {
    return { recents: [], stack: [], future: [] };
  }
}

function persistNav(
  recents: readonly RecentSurface[],
  stack: readonly Surface[],
  future: readonly Surface[],
): void {
  try {
    globalThis.localStorage?.setItem(
      NAV_HISTORY_STORAGE_KEY,
      serializeNavigation(recents, stack, future),
    );
  } catch {
    return;
  }
}

export function RennetApp({
  bridge,
  connectionSlot,
}: {
  bridge: RennetBridge;
  connectionSlot?: ReactNode;
}) {
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  // Whether the open review's original repository root still exists on disk (#324).
  // Set by bootstrap/load; fresh capture/openPr paths set it true. A gone root behaves
  // like a snapshot review (no freshness watcher, no live canvases) plus a plain status.
  const [repositoryPresent, setRepositoryPresent] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [diffFocus, setDiffFocus] = useState<DiffFocus>();
  const diffFocusNonce = useRef(0);
  // The review heart's ONE diff scroll container (issue #356): CodeView reports it via the
  // `scrollContainerRef` callback, and the conversation column reads it to align each thread
  // panel to the code row it discusses. Held in STATE (not a plain ref) so the element's
  // IDENTITY reaches the sibling rail: when CodeView unmounts/remounts — a zoom-out then into
  // another file — `setDiffScrollEl` re-fires and the memoised RefObject gets a fresh identity,
  // re-running the rail's alignment effect against the live element instead of a detached node
  // (Opus BUG-1). Null when no diff surface is mounted (another canvas angle) ⇒ rail stacks.
  const [diffScrollEl, setDiffScrollEl] = useState<HTMLElement | null>(null);
  const diffScrollRef = useMemo(() => ({ current: diffScrollEl }), [diffScrollEl]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Read the persisted navigation blob ONCE at mount (#324/#297).
  const storedNav = useRef<PersistedNavState | null>(null);
  if (storedNav.current === null) storedNav.current = readStoredNav();
  const [navigation, navigate] = useReducer(navHistoryReducer, null, () => {
    const stored = storedNav.current ?? { recents: [], stack: [], future: [] };
    // A persisted stack wins: the app reopens where the user left off. Absent → the
    // default Projects root (fresh install, or a v2/corrupt blob that carried no stack).
    return stored.stack.length > 0
      ? { stack: stored.stack, future: stored.future }
      : { stack: [{ kind: "projects" as const }], future: [] };
  });
  const currentSurface = navigation.stack.at(-1) ?? { kind: "projects" as const };
  const [recents, setRecents] = useState<RecentSurface[]>(() => storedNav.current?.recents ?? []);
  // The landing rehydrator's in-flight guard (#324): the surface identity currently
  // being reopened, so a re-render never double-fires a load.
  const rehydrating = useRef<string | null>(null);
  const navigationReady = review !== undefined;
  useEffect(() => {
    if (!navigationReady) return;
    if (currentSurface.kind !== "project" && currentSurface.kind !== "projects") return;
    setRecents((current) => recordRecent(current, currentSurface));
  }, [currentSurface, navigationReady]);
  // Persist recents AND the back/forward stack (#297 remainder) on every change, so a
  // restart reopens where the user left off.
  useEffect(() => persistNav(recents, navigation.stack, navigation.future), [recents, navigation]);
  // The legacy direct-entry capability is palette-only. It is an overlay beside
  // the surface stack, never a location recorded in navigation history.
  const [directEntryOpen, setDirectEntryOpen] = useState(false);
  // The settings screen (wireframe #15): opened from the front door, closed back
  // to it. `scheme` is the reviewer's chosen appearance, fetched once and applied
  // to the front door's `data-scheme` — so changing it in settings re-themes here.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const goBack = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    if (directEntryOpen) {
      setDirectEntryOpen(false);
      return;
    }
    navigate(navigateBack());
  }, [directEntryOpen, settingsOpen]);
  const goForward = useCallback(() => navigate(navigateForward()), []);
  const [scheme, setScheme] = useState<AppearanceScheme>("system");
  // Project detail (issue #37): the unified smart list. Clicking a project row opens
  // this surface (local work + every PR in one list); a row there opens the review.
  const [projectDetail, setProjectDetail] = useState<Project | null>(null);
  const [projectDetailData, setProjectDetailData] = useState<ProjectDetailData | null>(null);
  // The GitHub PR front door (the second v1 source): the ref the user typed
  // (`owner/repo#123` or a PR URL). Opening it picks the local clone, then lands
  // in the same review surface a working-tree capture does.
  const [prRef, setPrRef] = useState("");
  // Retrospective open (read-only): review an already-merged PR to READ the code,
  // with posting structurally off. Drives `review.openPr`'s `retrospective` flag.
  const [prRetrospective, setPrRetrospective] = useState(false);
  const [view, setView] = useState<"review" | "canvases">("canvases");
  // The live AI-produced canvas set. `null` until a real set loads — the UI shows
  // the honest running / consent / failed states in the meantime, NEVER fixture
  // canvases dressed up as a review. `liveLoaded` gates the workspace render.
  const [canvases, setCanvases] = useState<CanvasSet | null>(null);
  // The real per-element diff map (issue #60), delivered with the live set.
  const [elementDiffs, setElementDiffs] = useState<ElementDiffs>({});
  // The roll-up narration (issue #70): the zoom ladder's own voice, delivered
  // alongside the canvas set. Undefined until a live load sets whatever the engine
  // produced (still undefined → the honest pending state).
  const [narration, setNarration] = useState<ReviewNarration | undefined>(undefined);
  // The engine provenance (real-AI-default): how the live set was produced. When
  // `engine.aiReview` is false the set is the DETERMINISTIC mechanical outline (no
  // model installed, or the invocation budget refused it — #260) and the UI says
  // so loudly, never passing it off as AI.
  const [engine, setEngine] = useState<ReviewEngine | undefined>(undefined);
  // The Decisions runner's status (issue #137/#160), delivered with the canvas set.
  // Undefined until a live load sets it (or on an older engine that omits it) →
  // the Decisions lens defaults to `ok`. When the runner FAILED, this carries the
  // reason so the lens paints the failed banner instead of "no decisions".
  const [decisionsRun, setDecisionsRun] = useState<DecisionsRunStatus | undefined>(undefined);
  // The composition manifest (issue #30), bound to the exact review+patchset fetch
  // that produced it. Undefined until that load succeeds with a manifest.
  const [contextManifest, setContextManifest] = useState<
    { readonly fetchKey: string; readonly manifest: ContextManifest } | undefined
  >(undefined);
  const [liveLoaded, setLiveLoaded] = useState(false);
  // The Flagged lens's input (issue #138): the automated review layer's findings +
  // dual-review agreement for the open review. Fetched over the real command
  // boundary (a fixture stands behind it until the finding-generation runner lands);
  // undefined until it loads, so the lens shows the honest empty state meanwhile.
  const [flaggedReview, setFlaggedReview] = useState<FlaggedReview | undefined>(undefined);
  // The Spec angle's live OpenSpec change (wireframes #9): parse-on-open of the change
  // the reviewed patchset selected, over the real command boundary. Undefined until it
  // loads, or when the review touches no change — the Spec angle then shows its honest
  // empty state, never a fixture.
  const [openSpecChange, setOpenSpecChange] = useState<OpenSpecChange | undefined>(undefined);
  // The Spec view's requirement→hunk coverage (wireframes #9 / R53), keyed by
  // (capability, name). Undefined until the produced mapping resolves `ok`; a failed
  // or absent mapping leaves it undefined so the Spec view renders NO chips — an
  // uncomputed mapping never masquerades as a real zero.
  const [openSpecCoverage, setOpenSpecCoverage] = useState<OpenSpecCoverageIndex | undefined>(
    undefined,
  );
  // Dual-model review (issue #191): ON by DEFAULT (Rai's mandate, 2026-08-11 — the
  // tool's whole job is to spend tokens and run models, so dual-model + per-finding
  // verification are the default, never an opt-in). The human can opt a review DOWN
  // to the single-Claude quick review; that choice belongs to ONE review, so it is
  // KEYED BY reviewId and derived SYNCHRONOUSLY (`deepReviewOn`, below) rather than
  // reset in a lagging effect. This matters: if the mode were per-review STATE reset
  // in an effect, opening review B while review A is opted-down would let the flagged
  // fetch read A's inherited `false` in the SAME render — before the reset committed
  // `true` — firing a wasted single-seat run before the dual rerun. Deriving the mode
  // from reviewId means a new/other review reads the dual default in that same render.
  const [deepReviewChoice, setDeepReviewChoice] = useState<{
    reviewId: string;
    on: boolean;
  } | null>(null);
  // The Noise lens's input (issue #34): the low-signal churn grouped away for the
  // open review, each group tagged rule vs noise job. Fetched over the same real
  // command boundary as the flagged input (a fixture stands behind it until the
  // noise-classification runner lands); undefined until it loads, so the lens shows
  // the honest empty state meanwhile.
  // Stamped with the active patchset the fetch ran FOR (the flagged row's P0-2
  // binding pattern, applied UI-side because NoiseReview carries no boundary stamp):
  // a regenerate activates a new patchset under the same reviewId, and the old
  // groups are about the OLD diff. `boundNoiseReview` (below) drops a mismatched
  // result so a superseded noise grouping never renders beside the new diff.
  const [noiseReview, setNoiseReview] = useState<
    { readonly patchsetId: string; readonly result: NoiseReview } | undefined
  >(undefined);
  // The live load returned null (no harness / pipeline error) for THIS review, so
  // there is nothing real to show — the UI offers an honest error + retry rather
  // than silently standing on a demo.
  // Stamped with the canvasFetchKey the failed load was FOR (not a bare boolean):
  // a regenerate changes the key without re-running the view-gated load effect, and
  // the Angles rail must not paint the old attempt's "Failed" over a patchset that
  // was never attempted. Truthy checks elsewhere are unchanged (a key is truthy).
  const [loadFailed, setLoadFailed] = useState<string | false>(false);
  // Bumped by the retry affordance to re-run the live load for the same review
  // (e.g. after the user installs their Claude CLI and asks for the real review).
  const [reloadNonce, setReloadNonce] = useState(0);
  // The canvas-fetch guard is keyed on the review's IDENTITY (review id + active
  // patchset), NOT the churning `Review` object the 1500ms freshness poll (below)
  // deserializes fresh every tick (#59). `reviewRef` always holds the latest review
  // so the canvas effect can read it WITHOUT depending on that object reference — a
  // dependency on the object would re-run (and so cancel) the in-flight enrichment
  // fetch on every poll, and on a slow real harness the enrichment would never land.
  // `fetchedCanvasKey` records the identity that was ENRICHED, and only on SUCCESS,
  // so a cancelled or failed fetch retries and a regenerate (new patchset ⇒ new key)
  // re-fetches.
  const reviewRef = useRef<Review | null | undefined>(review);
  reviewRef.current = review;
  const fetchedCanvasKey = useRef<string | null>(null);
  // The DESTINATION (issue #64): the staged set is the north the review builds
  // toward. dispose == staged (a disposition stages in the same act it is made);
  // withdraw == unstage. The mode frames the same staged data as the own-branch
  // handoff bundle or the review to post on someone else's PR. `own-branch` is the
  // honest default for a local capture; the real mode arrives with the #20/#21
  // GitHub source. The publish sheet (#22 shell) is opened from the frame.
  const [draft, setDraft] = useState<CollationDraft>([]);
  // Discuss REQUESTS opened from the diff surface's glyphs (issue #36): a line
  // (plain-click), a range (shift-click), or the chunk header. Each click is a request
  // with its OWN occurrence id, handed to the host as `autoOpenRequests`. The host
  // dedups on the id (idempotent under re-render) while a second click on the SAME line
  // opens its own thread — `anchor.key` is only for margin alignment/grouping. This is
  // the felt gap: talk to the AI right on the line you are reading.
  const [discussRequests, setDiscussRequests] = useState<readonly DiscussRequest[]>([]);
  const [spanSelection, setSpanSelection] = useState<
    NonNullable<CommandInput<"review.ask">["selection"]> | undefined
  >(undefined);
  const [agentFocus, setAgentFocus] = useState<{ anchor: string; nonce: number } | undefined>(
    undefined,
  );
  const agentFocusNonce = useRef(0);
  const consumeAgentFocus = useCallback((nonce: number) => {
    setAgentFocus((current) => (current?.nonce === nonce ? undefined : current));
  }, []);
  // The EPHEMERAL per-item refinement state (issue #19), keyed by collation-item
  // id. An adopted refinement is durable on the item (`item.refined`); this map
  // holds only the in-flight/failed/no-change states the refine turn produces.
  const [refineStates, setRefineStates] = useState<Record<string, RefineItemState>>({});
  // The latest draft, readable synchronously inside an async refine continuation so
  // it can reject an outcome for a note that changed while the turn was in flight
  // (the closure `draft` is stale by then).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [destinationMode, setDestinationMode] = useState<DestinationMode>("own-branch");
  // The editable PR submission draft (issue #74, M26) — the own-branch composer's
  // title + body. Rennet drafts an honest account from the review; the human edits
  // it, and the edited form is what flows into the paper's preview (and a later
  // create act). `prDraftState` is the ephemeral drafting status (idle when absent).
  const [prDraft, setPrDraft] = useState<PrDraftValues>({ title: "", body: "" });
  const [prDraftState, setPrDraftState] = useState<PrDraftState | undefined>(undefined);
  // The generation of the current PR-body draft turn (#74 HIGH-2). Bumped on every
  // new draft AND on a review switch, so a late result from a superseded turn is
  // DROPPED rather than overwriting the current review's composer with another
  // turn's title/body (a stale-result swap).
  const prDraftGeneration = useRef(0);
  // The outcome of the last sign that ran the real `publish.review` engine (bead
  // wire-sign-publish). Signing the paper no longer clears the draft and closes —
  // it invokes the publish engine in DRY-RUN (builds the exact GitHub request,
  // posts nothing) and this holds what came back, which the paper then shows. Reset
  // whenever the paper is left or a fresh review loads, so a stale outcome never
  // lingers over a new draft.
  const [publishResult, setPublishResult] = useState<PublishOutcome | undefined>(undefined);
  // A publish is in flight (issue #21 double-sign race). The ref is the SYNCHRONOUS
  // re-entry guard — two completed signs fired before React re-renders both see it —
  // and the state disables the sign control so the paper reflects the pending post.
  const publishingRef = useRef(false);
  const [publishing, setPublishing] = useState(false);

  // The STAGE-6 HANDOFF (issue #72): the own-branch review hands its actionable
  // dispositions to a coding agent. `handoffComposed` is the composed bundle the
  // handoff paper previews — obtained from `review.handoff.compose` on surface entry
  // and treated as OPAQUE and IMMUTABLE between compose and run (the run passes this
  // exact object, digest and all). `handoffComposeState` is the compose lifecycle;
  // `handoffRun` is the run lifecycle, holding the `review.handoff.run` discriminated
  // outcome verbatim. A disposition change clears the bundle and resets the run (the
  // effect below), so re-entering the surface recomposes — the digest/stale guard in
  // MAIN is the backstop, this invalidation is the mechanism (Decision 3).
  // Typed as the run command's OWN bundle shape (the zod-inferred mutable form), so
  // the exact object the compose command returned flows into the run command untouched
  // — no readonly/mutable coercion, no restructuring between preview and run.
  const [handoffComposed, setHandoffComposed] = useState<
    { bundle: CommandInput<"review.handoff.run">["bundle"] } | undefined
  >(undefined);
  const [handoffComposeState, setHandoffComposeState] = useState<"idle" | "pending" | "error">(
    "idle",
  );
  const [handoffRun, setHandoffRun] = useState<HandoffRunState>({ status: "idle" });
  // The generation of the current compose turn: bumped on every invalidation so a
  // late compose result for dispositions that have since changed is DROPPED rather
  // than shown (the same stale-result guard `prDraftGeneration` uses).
  const handoffComposeGeneration = useRef(0);

  // The command palette (wireframes screen 16). The view store is LIFTED here so the
  // palette's Lens/Zoom/Appearance commands drive the SAME store the CanvasWorkspace
  // renders from (passed to it as `store` below) — the palette runs the real store
  // methods, never a parallel copy. `paletteOpen` toggles the ⌘K overlay.
  const viewStore = useMemo(() => createViewStore(), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // User keybinding overrides (#44), fetched with settings and overlaid on the
  // catalogue defaults at dispatch. A remap here is what key dispatch, the palette,
  // and conflict detection all read — so a remapped chord actually runs the
  // command (never a label that lies). Updated in state after each `setKeybinding`.
  const [keybindingOverrides, setKeybindingOverrides] = useState<KeybindingOverrides>({});
  // The live dispatch list + overrides, held in a ref so the window keydown listener
  // stays stable (subscribed once) while always reading the current commands. Set from
  // the built command list below, on every render.
  const dispatchRef = useRef<{ commands: Command[]; overrides: KeybindingOverrides }>({
    commands: [],
    overrides: {},
  });
  // Subscribed so the palette's toggle labels + current lens/zoom read live store state
  // (and so an inert command — the lens already active, a zoom at its clamp — is omitted).
  const canvasAngle = useViewStore(viewStore, (state) => state.angle);
  const canvasScheme = useViewStore(viewStore, (state) => state.scheme);
  const canvasOverlayOn = useViewStore(viewStore, (state) => state.overlayOn);
  const canvasZoomLevel = useViewStore(viewStore, (state) => state.zoom.level);

  // App-wide keyboard dispatch routes through the registry (#44): every pressed chord
  // is matched against the live commands' EFFECTIVE bindings (catalogue default overlaid
  // by the user's overrides), so a remapped chord runs its command and the old chord
  // stops. Workspace stops propagation after handling one of its own registry commands;
  // every other chord reaches this single app dispatcher. Bare chords never fire from an
  // editing control; the modified palette toggle remains available there.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const { commands, overrides } = dispatchRef.current;
      const pressed = chordFromEvent(event);
      const match = matchKeybinding(commands, pressed, overrides);
      if (!match) return;
      const target = event.target;
      const editing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (editing && (!pressed.mod || match.id !== "palette.toggle")) return;
      event.preventDefault();
      match.run();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    bridge
      .invoke("app.bootstrap", {})
      .then(({ review: restored, repositoryPresent: restoredRepositoryPresent }) => {
        setReview(restored);
        setRepositoryPresent(restoredRepositoryPresent);
        // A persisted stack restored (more than the Projects root) wins for
        // navigation — the rehydrator reconciles the held review to the tip. Only
        // when NO stack was restored do we land the latest review as before (#297).
        const hadRestoredStack = (storedNav.current?.stack.length ?? 0) > 0;
        if (restored && !hadRestoredStack) {
          navigate(pushSurface({ kind: "review", reviewId: restored.id }));
        }
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [bridge]);

  // The landing rehydrator (#324/#297): load whatever the surface we land on needs —
  // review-family → review.load (by id); project → project.detail + projects.list. One
  // mechanism serves boot restore, back/forward into a not-yet-loaded surface, and any
  // programmatic navigation, so there is no separate boot special-path. While a surface
  // rehydrates the render shows the loading treatment under its own crumb — never
  // another surface's content (the #305 regression class). A tip that can no longer
  // load is dropped with a plain status, flooring to the nearest restorable ancestor
  // (the Projects root always restores).
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadProjectDetail is a stable-by-intent body function (reads only bridge + setters); listing it would re-run the effect every render. The load-firing decision is keyed on currentSurface/review/projectDetail, which ARE listed.
  useEffect(() => {
    if (review === undefined) return; // bootstrap still resolving; the reducer holds the stack
    const surface = currentSurface;
    const identity = surfaceIdentity(surface);
    const isReviewFamily =
      surface.kind === "review" ||
      surface.kind === "draft" ||
      surface.kind === "paper" ||
      surface.kind === "handoff";
    if (isReviewFamily) {
      if (review && review.id === surface.reviewId) return; // already held
      if (rehydrating.current === identity) return; // in flight
      rehydrating.current = identity;
      const reviewId = surface.reviewId;
      void bridge
        .invoke("review.load", { commandId: crypto.randomUUID(), reviewId })
        .then((result) => {
          rehydrating.current = null;
          setReview(result.review);
          setRepositoryPresent(result.repositoryPresent);
        })
        .catch((reason: unknown) => {
          rehydrating.current = null;
          setError(reason instanceof Error ? reason.message : String(reason));
          navigate(discardNavigationTip());
        });
      return;
    }
    if (surface.kind === "project") {
      if (projectDetail && projectDetail.id === surface.projectId) return; // already loaded
      if (rehydrating.current === identity) return; // in flight
      rehydrating.current = identity;
      void loadProjectDetail(surface.projectId)
        .then(() => {
          rehydrating.current = null;
        })
        .catch((reason: unknown) => {
          rehydrating.current = null;
          setError(reason instanceof Error ? reason.message : String(reason));
          navigate(discardNavigationTip());
        });
    }
    // The Projects root needs no data — nothing to rehydrate.
  }, [currentSurface, review, projectDetail, bridge]);

  // The reviewer's appearance scheme (wireframe #15), fetched once so the front
  // door themes to it. Settings updates it live via `onSchemeChange`. Fail-quiet:
  // an unavailable settings surface leaves the builtin `system` default.
  useEffect(() => {
    bridge
      .invoke("settings.get", {})
      .then(({ scheme: loaded, keybindings }) => {
        setScheme(loaded);
        if (keybindings) setKeybindingOverrides(keybindings);
      })
      .catch(() => undefined);
  }, [bridge]);

  // `system` resolves through the OS via `prefers-color-scheme`, live: an OS
  // appearance change re-themes the app without a reload. `matchMedia` is guarded
  // for the (test / SSR) case where it is absent, defaulting to dark.
  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia === "undefined" || matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  // The single resolved scheme every app-level surface renders in. `system` folds
  // to the live OS value here, so every screen inherits ONE answer (no screen
  // hardcodes dark, and an explicit Light no longer reverts on navigation).
  const effectiveScheme: "dark" | "light" =
    scheme === "light" ? "light" : scheme === "dark" ? "dark" : systemDark ? "dark" : "light";

  // Apply the resolved scheme to the document ROOT, so every surface inherits it —
  // including screens that carry no `.rennet-glass`/`.canvas-app` scope of their own
  // (the restore + direct-entry screens, the review-level chrome). The self-scoping
  // components re-declare the base tokens locally, so they ALSO receive the resolved
  // scheme as a prop; this root attribute is what themes everything in between.
  useEffect(() => {
    document.documentElement.setAttribute("data-scheme", effectiveScheme);
  }, [effectiveScheme]);

  const patchset = useMemo(() => (review ? activePatchset(review) : undefined), [review]);
  // A GitHub-PR review is a SNAPSHOT of a pinned range, not the working tree, so
  // the working-tree freshness watcher below must not run against it (it would
  // capture the working tree, mint a different patchset, and wrongly invalidate
  // the PR review every tick). Derived from the patchset's provenance so it is
  // correct even for a restored PR review. Absent source ⇒ local capture.
  const isSnapshotReview =
    patchset?.source === "github-local" || patchset?.source === "github-rest";

  // A fresh (or regenerated) review invalidates any publish outcome shown on the
  // paper — the outcome was built from the prior review's draft. Clear it so a
  // stale dry-run summary never lingers over a different review.
  const reviewId = review?.id;
  useEffect(() => {
    if (!reviewId || !bridge.onAskStream) return;
    return bridge.onAskStream(reviewId, (event) => {
      if (event.kind !== "ask-focus") return;
      agentFocusNonce.current += 1;
      setAgentFocus({ anchor: event.anchor, nonce: agentFocusNonce.current });
    });
  }, [bridge, reviewId]);
  // The active patchset id, a stable string across the 1500ms freshness poll (which
  // swaps a byte-identical Review behind a fresh object ref). A REGENERATE changes it
  // under the SAME reviewId — the signal the flagged effect keys on so it refetches
  // and the binding below discards a result computed against the old patchset (P0-2).
  const activePatchsetId = review?.activePatchsetId;
  // The effective dual-model mode for the OPEN review, derived SYNCHRONOUSLY: the
  // opt-down choice only applies to the review it was made on, so any other review
  // (a fresh open, or one never opted down) reads the dual DEFAULT in the same render
  // the reviewId changes — never a stale `false` inherited for one render. This is
  // what stops an opted-down review A from leaking a wasted single-seat fetch onto
  // review B on open.
  const deepReviewOn =
    deepReviewChoice !== null && deepReviewChoice.reviewId === reviewId
      ? deepReviewChoice.on
      : true;
  // The canvas-fetch identity: a change of review OR active patchset (a regenerate)
  // is a new set to enrich; a no-op freshness poll keeps the same string, so it does
  // NOT re-run the canvas effect. Null until a review is open.
  const canvasFetchKey = review ? `${review.id}::${review.activePatchsetId}` : null;
  // The loaded set ↔ current identity binding (the rail's staleness guard):
  // `fetchedCanvasKey` records the id+patchset the held canvases were enriched for
  // (written only on success, before the state that triggers this render). A
  // regenerate or a review switch changes `canvasFetchKey` in the SAME render,
  // while the view-gated load effect may not re-fire on the Files view — so a
  // mismatch means `canvases`/`decisionsRun`/`engine` describe a superseded diff
  // and the Angles rail must render the honest pending state, never stale counts.
  const canvasSetCurrent = fetchedCanvasKey.current === canvasFetchKey;
  const shownContextManifest =
    contextManifest?.fetchKey === canvasFetchKey ? contextManifest.manifest : undefined;
  // The delta re-review digest (issue #73 / M25): when a successor review carries a
  // delta account, request the light-tier LLM TL;DR ONCE per (review, patchset) and
  // slot it atop the panel. The facts render immediately regardless; the digest is
  // optional garnish, simply absent on unavailable/failed — never a blank, never a
  // guess. Keyed like the canvas fetch so a regenerate re-requests and a no-op
  // freshness poll does not.
  const deltaDigestKey = review?.deltaAccount ? `${review.id}::${review.activePatchsetId}` : null;
  const [deltaDigest, setDeltaDigest] = useState<string | undefined>(undefined);
  const deltaDigestRequestedKey = useRef<string | null>(null);
  useEffect(() => {
    if (deltaDigestKey === null) {
      deltaDigestRequestedKey.current = null;
      setDeltaDigest(undefined);
      return;
    }
    // Fire at most once per (review, patchset): a re-render must not re-request; a new
    // re-review (a fresh key) requests afresh.
    if (deltaDigestRequestedKey.current === deltaDigestKey) return;
    deltaDigestRequestedKey.current = deltaDigestKey;
    setDeltaDigest(undefined); // facts first; the headline pops in when the turn returns
    const key = deltaDigestKey;
    const rid = review?.id;
    if (rid === undefined) return;
    void (async () => {
      try {
        const result = await bridge.invoke("review.deltaDigest", {
          commandId: crypto.randomUUID(),
          reviewId: rid,
        });
        // Drop a stale response if a newer successor superseded this request.
        if (deltaDigestRequestedKey.current !== key) return;
        if (result.status === "drafted") setDeltaDigest(result.text);
      } catch {
        // An honest absence: the facts stand on their own, never a fabricated digest.
      }
    })();
  }, [deltaDigestKey, review?.id, bridge]);
  // Bind the flagged result to the active patchset (P0-2, structural belt-and-braces
  // beside the effect-level clear): a result stamped with a superseded patchsetId is
  // dropped so the new diff never renders beside stale findings. Pure + unit-tested in
  // canvas/flagged.ts (independently red-provable, not masked by the effect fix).
  const boundFlaggedReview = useMemo(
    () => flaggedForPatchset(flaggedReview, activePatchsetId),
    [flaggedReview, activePatchsetId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on review identity only.
  useEffect(() => {
    setPublishResult(undefined);
  }, [reviewId]);

  useEffect(() => {
    // A gone repository root (a reopened review, #324) is watched like a snapshot: no
    // working-tree freshness poll runs against a path that isn't there (D6).
    if (!review || review.status === "invalid" || isSnapshotReview || !repositoryPresent) return;
    let checking = false;
    const timer = window.setInterval(() => {
      if (checking) return;
      checking = true;
      bridge
        .invoke("review.checkFreshness", {
          commandId: crypto.randomUUID(),
          reviewId: review.id,
          repoPath: review.repositoryRoot,
        })
        .then(({ review: refreshed }) => setReview(refreshed))
        .catch((reason: unknown) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => {
          checking = false;
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [bridge, review, isSnapshotReview, repositoryPresent]);

  useEffect(() => {
    if (!patchset?.files.some((file) => file.path === selectedPath)) {
      setSelectedPath(patchset?.files[0]?.path);
    }
  }, [patchset, selectedPath]);

  // A new review starts with NO live canvases: clear any prior review's set (and
  // its load-once guard) so the Canvases view never shows a stale AI review, or a
  // stale fallback banner, while the new review's real review loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on review identity only.
  useEffect(() => {
    setCanvases(null);
    setElementDiffs({});
    setNarration(undefined);
    setEngine(undefined);
    setDecisionsRun(undefined);
    setLiveLoaded(false);
    setLoadFailed(false);
    setFlaggedReview(undefined);
    setNoiseReview(undefined);
    setOpenSpecChange(undefined);
    setOpenSpecCoverage(undefined);
    setContextManifest(undefined);
    // The collation draft is review-scoped: it accumulates ONLY from acts on THIS
    // review (mark-read, per-anchor writes), and nothing reloads it per review. So
    // without clearing it, opening review B after A keeps A's dispositions — B's
    // destination frame, sign paper, and (the leak this closes) the composed handoff
    // would all form against A's asks. Clear the draft and its ephemeral refine states
    // so B starts empty. The handoff fingerprint keys on the draft, so this also fires
    // the compose invalidation, dropping any bundle composed against A.
    setDraft([]);
    setRefineStates({});
    // The PR-body draft (#74) is review-scoped: a fresh review starts with an empty,
    // un-drafted composer so review A's account never lingers over review B. Bump the
    // draft generation so a turn still in flight for the PREVIOUS review is dropped on
    // arrival rather than landing on the new review's composer (#74 HIGH-2).
    setPrDraft({ title: "", body: "" });
    setPrDraftState(undefined);
    prDraftGeneration.current += 1;
    // The diff-opened discuss requests are review-scoped (issue #36): a fresh review
    // starts with none, so a prior review's opened lines never reopen against the
    // remounted (review-keyed) conversation host.
    setDiscussRequests([]);
    setSpanSelection(undefined);
    setAgentFocus(undefined);
    agentFocusNonce.current = 0;
    setDiffFocus(undefined);
    diffFocusNonce.current = 0;
    // Reset the LIFTED view store's review-scoped state (lens/zoom/selection/cursor/
    // cohorts/overlay), preserving the scheme. The store now outlives a single review
    // (it was lifted here for the ⌘K palette), so without this reset, opening review B
    // after viewing review A at diff depth would render B at "Diff" with A's selection —
    // a hunk that does not exist in B, so no diff. Before the lift, unmounting the
    // workspace discarded the store; this restores that clean-per-review guarantee.
    viewStore.getState().resetView();
    // NOTE: the dual-model mode is NOT reset here. It is derived synchronously from
    // reviewId (`deepReviewOn`, above), so a new review already reads the dual default
    // this same render — resetting it in this effect would commit a render too late
    // and leak a wasted single-seat fetch for the prior review's opt-down.
    fetchedCanvasKey.current = null;
  }, [reviewId]);

  // A regenerate changes the patchset without changing reviewId. Clear the prior
  // composition immediately; the fetch-key binding below is the structural backstop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on review+patchset identity.
  useEffect(() => {
    setContextManifest(undefined);
  }, [canvasFetchKey]);

  // The Flagged lens (issue #138): fetch the automated review layer's findings for
  // the open review over the real command boundary. This is NOT a cheap read — the
  // `flagged.review` command runs the full budget-ceilinged hypothesis + dual-model +
  // verify pipeline on review open. That eager auto-run is intended MVP behaviour
  // (#158): the product's core output should be there when the review opens, ceilinged
  // by `createInvocationBudget`, not withheld behind an on-lens ritual. Its own
  // try/catch means a flagged fetch failure never disturbs the canvas load.
  useEffect(() => {
    // A gone repository (#324/D6): the pipeline cannot run against a path that
    // isn't there, so no doomed fetch fires — the rail says "Unavailable" instead.
    if (!reviewId || !repositoryPresent) return;
    let cancelled = false;
    let adjudicationPoll: ReturnType<typeof setTimeout> | undefined;
    const pollAdjudication = (): void => {
      if (cancelled || !activePatchsetId) return;
      void bridge
        .invoke("flagged.adjudication", {
          reviewId,
          patchsetId: activePatchsetId,
          deepReview: deepReviewOn,
        })
        .then((result) => {
          if (cancelled) return;
          if (result.status === "pending") {
            adjudicationPoll = setTimeout(pollAdjudication, 100);
            return;
          }
          if (result.status !== "complete") return;
          const enriched = result.review;
          if (
            (enriched.status === "ok" || enriched.status === "failed") &&
            enriched.patchsetId === activePatchsetId
          ) {
            setFlaggedReview(enriched);
          }
        })
        .catch(() => {
          // The initial verified rows are already rendered. A missing/failed late
          // read leaves them untouched; adjudication informs and never gates.
        });
    };
    // Clear any prior flagged result the instant this effect re-fires (P0-2). It re-fires
    // on a REGENERATE too — a new active patchset under the SAME reviewId — and the old
    // hypothesis/findings/cross-check are about the OLD diff. Without this clear (and the
    // `activePatchsetId` dep below), the new canvases would render beside the stale flagged
    // result: internally consistent, about the wrong diff. Clearing hides the frame until
    // the new patchset's flagged review lands, and the `cancelled` guard drops any
    // old-patchset fetch still in flight so it can never set state over the new diff.
    setFlaggedReview(undefined);
    // `deepReview` selects the two-model reconcile (issue #191), which is now the
    // DEFAULT. We send the flag EXPLICITLY (never omit) because the command boundary
    // now defaults an omitted flag to DUAL — so an opt-down to quick has to travel as
    // an explicit `false`, or the omission would silently run dual anyway.
    void bridge
      .invoke("flagged.review", {
        reviewId,
        deepReview: deepReviewOn,
      })
      .then((result) => {
        // Trust boundary (#148): a runner whose result we cannot READ is NOT an
        // all-clear. A valid `{status:"ok"|"failed"}` passes through as-is; ANY
        // other shape is a result we cannot trust and MUST surface as `failed` —
        // never be dropped to undefined, which defaults to ok-empty downstream and
        // reads as "ran clean". A check that could not complete must say
        // "Couldn't check", never rubber-stamp the diff.
        if (cancelled) return;
        const review = result as Partial<FlaggedReview> | undefined;
        if (review?.status === "ok" || review?.status === "failed") {
          setFlaggedReview(review as FlaggedReview);
          if (
            review.status === "ok" &&
            (review.lateEnrichmentScheduled === true ||
              (deepReviewOn &&
                review.findings?.some(
                  (finding) =>
                    finding.agreement.kind === "disagree" &&
                    finding.agreement.adjudication === undefined,
                )))
          ) {
            pollAdjudication();
          }
        } else {
          setFlaggedReview({
            status: "failed",
            reason: "The flagged review returned a response Rennet could not read.",
          });
        }
      })
      .catch((reason: unknown) => {
        // A rejected fetch (no handler, transport error, a thrown runner) is a
        // failure to CHECK, not a clean result — surface it honestly as `failed`.
        if (cancelled) return;
        setFlaggedReview({
          status: "failed",
          reason: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      cancelled = true;
      if (adjudicationPoll) clearTimeout(adjudicationPoll);
    };
  }, [reviewId, activePatchsetId, repositoryPresent, bridge, deepReviewOn]);

  // The Spec angle (wireframes #9): parse-on-open of the change the reviewed patchset
  // selected, over the real command boundary. Deterministic — NO model spend. A missing
  // change or a failed read leaves openSpecChange undefined (the Spec angle shows its
  // honest empty state), never a fixture.
  useEffect(() => {
    if (!reviewId) return;
    let cancelled = false;
    void bridge
      .invoke("openspec.change", { reviewId })
      .then((result) => {
        if (cancelled) return;
        setOpenSpecChange((result as OpenSpecChange | null) ?? undefined);
      })
      .catch(() => {
        if (cancelled) return;
        setOpenSpecChange(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, bridge]);

  // The Spec view's coverage chips (wireframes #9 / R53): fetch the produced
  // requirement→hunk mapping for the open review. It spends a budgeted model turn ONLY
  // when the review actually touches an OpenSpec change (the producer returns null
  // otherwise, before any turn), so a non-spec review pays nothing. A `null`/`failed`
  // result leaves the coverage index undefined — the Spec view renders no chips, and
  // an uncomputed mapping never masquerades as a real zero. Its own try/catch means a
  // coverage failure never disturbs the change fetch or the canvas load.
  useEffect(() => {
    if (!reviewId) return;
    let cancelled = false;
    void bridge
      .invoke("openspec.coverage", { reviewId })
      .then((result) => {
        if (cancelled) return;
        const coverage = result as OpenSpecCoverage | null;
        // Only a mapping that RAN (`ok`) yields chips; failed/absent ⇒ no chips.
        if (coverage?.status !== "ok") {
          setOpenSpecCoverage(undefined);
          return;
        }
        const index: OpenSpecCoverageIndex = new Map(
          coverage.edges.map((edge) => [
            openSpecRequirementCoverageKey(edge.capability, edge.requirement),
            { hunks: edge.hunks, tests: edge.tests },
          ]),
        );
        setOpenSpecCoverage(index);
      })
      .catch(() => {
        if (cancelled) return;
        setOpenSpecCoverage(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, bridge]);

  // The Noise lens (issue #34): fetch the low-signal churn grouped away for the open
  // review over the real command boundary. It spends a budgeted model invocation like
  // flagged; its own try/catch means a noise fetch failure never disturbs the
  // canvas load or the flagged fetch. Keyed on the active patchset like the flagged
  // effect (P0-2): a regenerate clears and refetches, and the result is stamped with
  // the patchset it ran for so a stale landing never binds to the new diff. A gone
  // repository (#324/D6) fires no doomed fetch, exactly like the canvas load.
  useEffect(() => {
    if (!reviewId || !activePatchsetId || !repositoryPresent) return;
    let cancelled = false;
    // Clear the prior result the instant this re-fires — the old groups are about
    // the old patchset; the rail/lens show the honest in-flight state meanwhile.
    setNoiseReview(undefined);
    const fetchedFor = activePatchsetId;
    void bridge
      .invoke("noise.review", { reviewId })
      .then((result) => {
        // Trust boundary (#152): a runner whose result we cannot READ is NOT an
        // all-clear. A valid `{status:"ok"|"failed"}` passes through as-is; ANY
        // other shape is a result we cannot trust and MUST surface as `failed` —
        // never be dropped to undefined, which defaults to ok-empty downstream and
        // reads as "ran clean". A check that could not complete must say
        // "Couldn't check", never rubber-stamp the diff.
        if (cancelled) return;
        const review = result as Partial<NoiseReview> | undefined;
        if (review?.status === "ok" || review?.status === "failed") {
          setNoiseReview({ patchsetId: fetchedFor, result: review as NoiseReview });
        } else {
          setNoiseReview({
            patchsetId: fetchedFor,
            result: {
              status: "failed",
              reason: "The noise review returned a response Rennet could not read.",
            },
          });
        }
      })
      .catch((reason: unknown) => {
        // A rejected fetch (no handler, transport error, a thrown runner) is a
        // failure to CHECK, not a clean result — surface it honestly as `failed`.
        if (cancelled) return;
        setNoiseReview({
          patchsetId: fetchedFor,
          result: {
            status: "failed",
            reason: reason instanceof Error ? reason.message : String(reason),
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, activePatchsetId, repositoryPresent, bridge]);
  // The patchset-bound noise result (the flagged row's `flaggedForPatchset`
  // pattern): a result stamped with a superseded patchset reads as undefined —
  // the honest in-flight state — never as the new diff's grouping.
  const boundNoiseReview =
    noiseReview !== undefined && noiseReview.patchsetId === activePatchsetId
      ? noiseReview.result
      : undefined;

  // Live canvases (issue #54): when a real review is open and the Canvases view is
  // shown, fetch the engine-produced canvas set once and render the REAL AI review.
  // Running the harness is Rennet's whole job — it just runs, with no permission
  // gate or consent step. A failure (no harness, pipeline error) returns null and is
  // surfaced as an honest error + retry — never a demo standing in for a review.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce re-triggers the load on retry; review is read via reviewRef, keyed by canvasFetchKey.
  useEffect(() => {
    if (view !== "canvases") return;
    // A reopened review whose repository is gone (#324) can't run the live pipeline —
    // the renderer already knows this and skips straight to the honest unavailable
    // state instead of firing a load that must fail (D6). No `review.canvases` invoked.
    if (!repositoryPresent) return;
    // Read the review off the ref, NOT the dependency array: this effect is keyed on
    // `canvasFetchKey` (review id + active patchset), so a no-op 1500ms freshness
    // poll — which swaps in a byte-identical `Review` behind a fresh object
    // reference — no longer re-runs it and therefore no longer cancels an in-flight
    // enrichment fetch (#59). `reviewRef.current` is the same review `canvasFetchKey`
    // was derived from this render, so its id/patchset match the key.
    const current = reviewRef.current;
    if (!current || !canvasFetchKey) return;
    // Already enriched THIS id+patchset: the success-recorded key blocks a redundant
    // refetch. A cancelled/failed fetch never records, so it stays free to retry.
    if (fetchedCanvasKey.current === canvasFetchKey) return;
    setLoadFailed(false);
    setContextManifest(undefined);
    let cancelled = false;
    void loadCanvases(bridge, current, deepReviewOn).then((live) => {
      if (cancelled) return;
      if (!live) {
        // Nothing real came back — surface it honestly rather than standing on a demo.
        // The key is NOT recorded, so the retry affordance (which bumps `reloadNonce`)
        // re-runs this and fetches again — a failed load never poisons the identity.
        setLoadFailed(canvasFetchKey);
        setContextManifest(undefined);
        return;
      }
      // Record the enriched identity ONLY here, on success (#59): a slow fetch that
      // outlived one or more freshness polls still lands, and the recorded key then
      // prevents a redundant refetch of the SAME id+patchset.
      fetchedCanvasKey.current = canvasFetchKey;
      setCanvases(live.canvases);
      setElementDiffs(live.elementDiffs);
      setNarration(live.narration);
      setEngine(live.engine);
      setDecisionsRun(live.decisionsRun);
      setContextManifest(
        live.contextManifest
          ? { fetchKey: canvasFetchKey, manifest: live.contextManifest }
          : undefined,
      );
      setLiveLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [view, canvasFetchKey, bridge, reloadNonce, repositoryPresent, deepReviewOn]);

  // Retry the live load for the current review (the honest-failure and mechanical-
  // fallback surfaces both offer this). Clearing the load-once guard + bumping the
  // nonce re-runs the effect above; e.g. the user installs their Claude CLI, then
  // asks for the real AI review without reopening the app.
  function retryLiveLoad(): void {
    fetchedCanvasKey.current = null;
    setLoadFailed(false);
    setLiveLoaded(false);
    setReloadNonce((nonce) => nonce + 1);
  }

  async function chooseRepository(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const { path } = await bridge.invoke("repository.choose", {});
      if (!path) return;
      const result = await bridge.invoke("review.capture", {
        commandId: crypto.randomUUID(),
        repoPath: path,
      });
      setReview(result.review);
      setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
      setDirectEntryOpen(false);
      navigate(ascendNavigationTo(0));
      navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  // Open a review from a project-detail row (issue #37).
  //  • A PR row now targets the SPECIFIC pull request: `review.openPr` over
  //    `owner/name#number` (B2 carries `repository` on the row). A merged/closed
  //    (read-only) PR opens retrospectively — nothing can be posted. The local clone
  //    is the project's own path; per-repo clone resolution for a workspace PR across
  //    multiple repos is a follow-up.
  //  • A local-work row captures the project's working tree (B1 behaviour). Per-branch
  //    range targeting for a specific local branch is a follow-up.
  async function openRow(project: Project, row: SmartRow): Promise<void> {
    if (row.kind === "pr" && row.pr) {
      await openProjectPr(project, `${row.pr.repository}#${row.pr.number}`, row.readOnly);
      return;
    }
    await openProject(project);
  }

  async function openProjectPr(
    project: Project,
    ref: string,
    retrospective: boolean,
  ): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await bridge.invoke("review.openPr", {
        commandId: crypto.randomUUID(),
        ref,
        repoPath: project.openPath,
        retrospective,
      });
      setReview(result.review);
      setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
      navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openProject(project: Project): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const result = await bridge.invoke("review.capture", {
        commandId: crypto.randomUUID(),
        repoPath: project.openPath,
      });
      setReview(result.review);
      setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
      navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  // Open a pull request into a review (the front door's second source). The user
  // types the ref and MAIN resolves the clone itself — a matching local clone when
  // one is known, the managed blobless clone otherwise (clone-on-demand, #225).
  // Only when the automatic clone fails (e.g. a private repo with no ambient git
  // credentials) does the directory dialog appear as the fallback.
  async function openPullRequest(): Promise<void> {
    const ref = prRef.trim();
    if (!ref) return;
    setBusy(true);
    setError(undefined);
    try {
      let repoPath: string | undefined;
      try {
        await openPrRef(ref, repoPath);
        return;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (!message.includes("Pick a local clone")) throw reason;
        // Clone-on-demand could not clone the repo; fall back to the picker.
        const { path } = await bridge.invoke("repository.choose", {});
        if (!path) return;
        repoPath = path;
      }
      await openPrRef(ref, repoPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openPrRef(ref: string, repoPath: string | undefined): Promise<void> {
    const result = await bridge.invoke("review.openPr", {
      commandId: crypto.randomUUID(),
      ref,
      ...(repoPath === undefined ? {} : { repoPath }),
      // Read-only when the reviewer asked to review the PR retrospectively: the
      // created review is flagged and nothing can be posted from it.
      retrospective: prRetrospective,
    });
    setReview(result.review);
    setRepositoryPresent(true); // a fresh capture/openPr always has its repo present
    setDirectEntryOpen(false);
    navigate(ascendNavigationTo(0));
    navigate(pushSurface({ kind: "review", reviewId: result.review.id }));
  }

  async function setFileRead(path: string, read: boolean): Promise<void> {
    if (!review) return;
    // Mark-read sets a neutral "comment" disposition; mark-unread clears it.
    // The full disposition UI (approve / request-change / question) is a later slice.
    // dispose == staged / withdraw == unstage: the same act collates (or unstages)
    // it into the draft, so the north fills as the review is worked.
    setDraft((current) =>
      read
        ? ingestWrites(current, [{ path, type: "comment", body: "" }])
        : withdrawPath(current, path),
    );
    const result = await bridge.invoke("review.setDisposition", {
      commandId: crypto.randomUUID(),
      reviewId: review.id,
      patchsetId: review.activePatchsetId,
      path,
      disposition: read ? "comment" : null,
      body: "",
    });
    setReview(result.review);
  }

  // ── The stage-6 handoff loop (issue #72): compose → preview → run ────────────
  // The effective handoff dispositions (addressed types, effective bodies, draft
  // order) are what `review.handoff.compose` is handed and what the affordance counts
  // as actionable. Fingerprinting them drives the invalidation: when they change, the
  // stored bundle is stale and the run must not use it.
  const handoffAsks = handoffDispositions(draft);
  const handoffDispositionsFingerprint = JSON.stringify({
    reviewId,
    patchsetId: activePatchsetId,
    asks: handoffAsks,
  });
  // Invalidate the composed bundle whenever the effective dispositions change
  // (Decision 3): bump the compose generation (dropping any in-flight compose),
  // clear the bundle, and reset the run. This implements the spec's "recomposing
  // replaces the preview" in the renderer; MAIN's digest/stale refusal is the backstop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — fire ON the fingerprint change; the body reads only stable setters + the generation ref, never the fingerprint, so biome reads the dep as "unnecessary", but dropping it would stop the invalidation.
  useEffect(() => {
    handoffComposeGeneration.current += 1;
    setHandoffComposed(undefined);
    setHandoffComposeState("idle");
    setHandoffRun({ status: "idle" });
  }, [handoffDispositionsFingerprint]);
  // Compose on handoff-surface entry (Decision 2): one light-tier turn over the
  // effective dispositions. Fires only from the idle state with no stored bundle, so
  // it never loops (pending/error/composed all fall through) and never re-fires a
  // failed compose on its own — a disposition change re-arms it. The fail-closed floor
  // means even a model failure yields a runnable `composed:false` bundle, not a dead
  // end; a genuine transport failure surfaces as the honest error state. Leaving the
  // surface resets that error to idle (the effect below), so a re-entry recomposes
  // fresh rather than dead-ending on a stale transport error until a disposition edit.
  useEffect(() => {
    if (currentSurface.kind !== "handoff") return;
    if (handoffComposed !== undefined || handoffComposeState !== "idle") return;
    const openReview = reviewRef.current;
    if (!openReview) return;
    const dispositions = handoffDispositions(draftRef.current);
    const generation = handoffComposeGeneration.current;
    setHandoffComposeState("pending");
    void (async () => {
      try {
        const { bundle } = await bridge.invoke("review.handoff.compose", {
          commandId: crypto.randomUUID(),
          reviewId: openReview.id,
          dispositions,
        });
        if (handoffComposeGeneration.current !== generation) return; // superseded
        setHandoffComposed({ bundle });
        setHandoffComposeState("idle");
      } catch {
        if (handoffComposeGeneration.current !== generation) return;
        setHandoffComposeState("error");
      }
    })();
  }, [currentSurface.kind, handoffComposed, handoffComposeState, bridge]);
  // A transport error is not sticky: on LEAVING the handoff surface, reset the compose
  // state from `error` back to `idle` so the next entry recomposes (the entry effect
  // above fires only from idle). Without this, a failed compose forces the reviewer to
  // make an artificial disposition edit just to re-arm the surface — the C5 dead-end.
  useEffect(() => {
    if (currentSurface.kind === "handoff") return;
    setHandoffComposeState((state) => (state === "error" ? "idle" : state));
  }, [currentSurface.kind]);
  // Run the previewed bundle (issue #72). The stored bundle is passed UNTOUCHED —
  // same object, same digest — so MAIN verifies exactly what the paper showed; the
  // renderer never recomposes, edits, or substitutes it (the spec's "the run receives
  // the previewed bundle"). The discriminated outcome is stored verbatim: a refusal
  // renders as a refusal, a failure as an error, and no non-success is dressed as
  // success. The successor patchset IS consumed downstream: the run capture threads
  // the ask trace into the hunk-grain delta account (#73, shipped).
  async function runHandoff(): Promise<void> {
    const openReview = reviewRef.current;
    const composed = handoffComposed;
    if (!openReview || !composed) return;
    if (handoffRun.status === "pending") return; // re-entry guard
    // Capture the compose generation at run start. Every invalidation (a disposition
    // edit OR a review switch — both change the handoff fingerprint) bumps it and
    // resets the run to idle. So a run resolving AFTER such a change is stale: its
    // outcome belongs to a bundle/review that is no longer on screen, and applying it
    // would render A's run result on B's paper. Drop it, exactly as the compose turn
    // drops a superseded result.
    const generation = handoffComposeGeneration.current;
    setHandoffRun({ status: "pending" });
    try {
      const outcome = await bridge.invoke("review.handoff.run", {
        commandId: crypto.randomUUID(),
        reviewId: openReview.id,
        bundle: composed.bundle,
      });
      if (handoffComposeGeneration.current !== generation) return; // superseded
      setHandoffRun(outcome);
    } catch (reason) {
      if (handoffComposeGeneration.current !== generation) return; // superseded
      setHandoffRun({
        status: "failed",
        reason: reason instanceof Error ? reason.message : String(reason),
        filesTouched: [],
      });
    }
  }

  // The always-present destination chrome and the two surfaces it opens (R40):
  // frame → collation draft canvas (editable glass) → paper (sign). dispose ==
  // staged flows through here; signing this shell performs NO Git/GitHub mutation
  // (the #21 pipeline is a later slice) — it clears the draft to demonstrate the
  // full journey ending somewhere. The `.rennet-glass` wrapper carries the glass +
  // paper tokens (the shared @rennet/theme tokens) WITHOUT the
  // full-screen `.canvas-app` layout, so the fixed frame and the overlays theme
  // correctly. `data-scheme="dark"` gives the warm-dark paper (the R40 fix); the
  // bright-room cream lives under `[data-scheme="light"]`.
  const destinationVariantForMode = destinationVariant(destinationMode);
  // The variant-specific outbound target (issue #22), derived from the ONE draft.
  // The branch context comes from the active patchset's provenance — an honest
  // local-capture head (the head SHA short form) toward its base ref; the #20/#21
  // GitHub source supplies real branch names later. No span anchors yet on the
  // local-capture path (#78 feeds them), so other-pr comments post file-level —
  // honest, because a path-grained disposition genuinely has no single line.
  // The drafted-then-edited PR title/body (#74, M26) override the deterministic
  // derivation when the human has one: a non-empty title/body from the composer
  // flows into the submission the paper previews and signs, so what leaves is the
  // human's account. Empty ⇒ the pre-M26 behaviour (title from head, composed body).
  const prTitle = prDraft.title.trim();
  const prBody = prDraft.body.trim();
  const publishContext: PublishContext = {
    submission: {
      base: patchset?.repository.baseRef ?? "main",
      // The head is a BRANCH ref (#107), never a commit SHA — a GitHub PR cannot open
      // with a bare SHA as `head`. The capture records the current branch name
      // (`headRef`); a detached HEAD has no branch and reads honestly as such, and the
      // sign path refuses it rather than opening a PR against a non-branch.
      head: patchset ? (patchset.repository.headRef ?? "(detached HEAD)") : "(working tree)",
      draftDefault: true,
      ...(prTitle === "" ? {} : { title: prTitle }),
      ...(prBody === "" ? {} : { body: prBody }),
    },
  };
  // The SINGLE source of truth for what publishes (issue #109). The human's
  // ink/blue staging choice — approve never travels, request-change always does,
  // comment/question travel only when explicitly staged — is applied HERE, once,
  // by filtering to the ink (published) subset. Everything outbound (the paper's
  // preview + the sign wire) derives from this, so what the human staged is
  // exactly what publishes. The editing surfaces (DestinationFrame, the draft
  // canvas) keep the FULL `draft`: they show every disposition with its lane, and
  // the ink/blue split is what they render. Before this seam, `publishTarget` and
  // `publishReview` both read the full `draft`, so an unstaged comment/question
  // still entered the payload and an approve-only draft still ran an APPROVE dry
  // run while the chrome said "Nothing to publish".
  const inkDraft = publishedItems(draft);
  // #74 HIGH: bind the PR-body draft generation to the FULL drafting-input identity,
  // not just the review id. Two things change the inputs WITHOUT changing `reviewId`,
  // so the reviewId-keyed reset never fired and a stale turn overwrote the composer:
  //   • REGENERATION activates a new `activePatchsetId` under the SAME review — a
  //     turn drafted against patchset A would land its body on patchset B.
  //   • a STAGE/UNSTAGE edit changes the ink projection — a note that was ink when
  //     the turn started (and so folded into the drafted body) but is BLUE by the
  //     time it resolves would still reach the paper. Filtering the input to `inkDraft`
  //     settles what was ink AT REQUEST TIME; this closes the time-of-check/
  //     time-of-use window by binding the RESULT to the input identity too.
  // Fingerprint EXACTLY the inputs `draftPrBody` sends. When it changes, the effect
  // below bumps the generation (so any in-flight turn is dropped on arrival) and
  // clears the drafting STATUS. The composer's own text is the human's and is left
  // untouched — only a turn drafting against inputs that no longer exist is voided.
  const prDraftRollup = narration?.rollup;
  const prDraftInputFingerprint = JSON.stringify({
    patchsetId: activePatchsetId,
    base: publishContext.submission.base,
    head: publishContext.submission.head,
    dispositions: inkDraft.map((item) => ({
      type: item.type,
      path: item.path,
      resolution: effectiveBody(item),
    })),
    narration:
      prDraftRollup?.status === "narrated"
        ? { oneLine: prDraftRollup.oneLine, paragraph: prDraftRollup.paragraph }
        : null,
    requirements: (openSpecChange?.specDeltas ?? []).flatMap((delta) =>
      delta.groups.flatMap((group) =>
        group.requirements.map((requirement) => requirement.statement),
      ),
    ),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — the effect FIRES ON the fingerprint change to void an in-flight turn; its body reads only the stable generation ref + setter (never the fingerprint), so biome reads the dep as "unnecessary", but dropping it would stop the invalidation.
  useEffect(() => {
    // The drafting inputs changed (a regeneration, a stage/unstage, or a narration/
    // spec refresh): void any in-flight turn by bumping the generation the async
    // continuation checks, and clear a drafting status that no longer describes the
    // current inputs. The composer text is left untouched — the human's edit is final.
    prDraftGeneration.current += 1;
    setPrDraftState(undefined);
  }, [prDraftInputFingerprint]);
  const publishTargetForMode = publishTarget(destinationMode, inkDraft, publishContext);
  // The degradation ledger, sourced HONESTLY from the active patchset: a degraded
  // (REST-fallback) changeset really did flatten, so it gates the sign. A clean
  // local capture carries no degradation → no ledger, no gate. #22/council maps the
  // full run-degradation set here later.
  const publishLedger: PublishLedger | undefined = patchset?.degraded
    ? {
        entries: [
          {
            id: "changeset-degraded",
            summary:
              patchset.degradationReason ??
              "This changeset was captured via a degraded path; some structure was flattened.",
            kind: "flattened",
          },
        ],
      }
    : undefined;
  // Sign the paper by running the real publish engine (bead wire-sign-publish; the
  // real-post flip, issue #21). Builds the review-comments outbound form from the
  // collated draft — the SAME `inkDraft` bytes the paper previewed — then invokes
  // `publish.review`:
  //   • A review opened from a REAL pull request carries `review.postTarget` (the
  //     repo + PR number + forge node id + reviewed head). On a completed hold-to-sign
  //     THIS function runs, mints the single-use consent token bound to exactly
  //     (review, target, payload) via `publish.requestConsent`, then sends the review
  //     for REAL (`dryRun: false`, carrying that token). MAIN re-derives the canonical
  //     payload and fails CLOSED on any drift (R33), so what the paper showed is what
  //     leaves — byte-for-byte.
  //   • A LOCAL working-tree review has no `postTarget` (there is no PR to post to),
  //     so the sign stays a DRY RUN against the local-preview target: MAIN builds the
  //     exact request and posts NOTHING, honestly.
  // The consent token is minted ONLY here, ONLY inside the completed sign — never
  // autonomously, never by any other path — so a real post cannot happen without the
  // human's hold-to-sign. A partial/absent hold never calls this function.
  async function publishReview(): Promise<void> {
    if (!review || !patchset) return;
    // Re-entry guard (issue #21 double-sign race): a publish already in flight must
    // not start a second — two completed signs before a re-render would otherwise mint
    // and consume two tokens. The ref is synchronous (state lags a render); the sign
    // control is also disabled via `publishing` below.
    if (publishingRef.current) return;
    // Publish the INK subset only (issue #109), never the full draft — the same
    // `inkDraft` the paper previewed. An approve-only (or all-unstaged) draft has
    // an empty ink subset, so `comments` is empty and the sign is a no-op: no
    // APPROVE dry run, matching the "Nothing to publish" the chrome shows.
    const comments = reviewComments(inkDraft, publishContext.anchors);
    if (comments.length === 0) return; // the paper's sign is already disabled when empty
    const payload = reviewCommentsPayload(comments);
    const verdict = deriveReviewEvent(comments);
    // The REAL post-target lives on the review iff it was opened from a real PR and is
    // not retrospective; its presence is exactly "this review may post to a real PR".
    // Absent ⇒ a local capture: fall to the local-preview dry-run target (posts nothing).
    const realTarget = review.retrospective ? undefined : review.postTarget;
    const target = realTarget ?? previewPublishTarget(patchset.repository);
    // The canonical review-comment shape MAIN validates against `payload` (the ui
    // `ReviewComment` carries a `refined` flag the command schema does not — drop it,
    // and omit an absent line so `line ?? null` matches on both sides).
    const commentsInput = comments.map((comment) => ({
      path: comment.path,
      ...(comment.line !== undefined ? { line: comment.line } : {}),
      side: comment.side,
      type: comment.type,
      body: comment.body,
    }));
    publishingRef.current = true;
    setPublishing(true);
    setBusy(true);
    setError(undefined);
    try {
      // Mint the single-use consent token ONLY for a real post (real target present).
      // Bound to (review, target, payload, verdict): MAIN consumes it at egress and any
      // drift in target, payload, or verdict voids it. This is the sole minting site,
      // reached only on a completed hold-to-sign.
      let authorization: string | undefined;
      if (realTarget) {
        const consent = await bridge.invoke("publish.requestConsent", {
          commandId: crypto.randomUUID(),
          reviewId: review.id,
          target: realTarget,
          payload,
          verdict,
        });
        authorization = consent.authorization;
      }
      const outcome = await bridge.invoke("publish.review", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
        target,
        comments: commentsInput,
        payload,
        verdict,
        // Real post iff we hold a consent token (real target); otherwise a dry run.
        // An omitted flag never posts — the real path opts in explicitly with false.
        ...(authorization ? { authorization, dryRun: false } : { dryRun: true }),
      });
      setPublishResult({
        kind: "review",
        dryRun: outcome.dryRun,
        verdict,
        count: comments.length,
        targetLabel: previewTargetLabel(target),
        endpoint: outcome.request.endpoint,
        method: outcome.request.method,
        marker: outcome.marker,
        ledgerCount: outcome.ledger.length,
        // A real post targets a real PR; only the local-capture path is a preview.
        preview: realTarget === undefined,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      publishingRef.current = false;
      setPublishing(false);
      setBusy(false);
    }
  }
  // Submit the own-branch PR (issue #257 / #107): on sign, push the review's own
  // branch and open a real pull request with the drafted title/body. This is a
  // DIFFERENT verb on the same GitHub egress the other-pr post travels — push +
  // create, not comment — so it never falls back to `publish.review` (that would emit
  // review comments the human never previewed). Pushing your own branch is not
  // publishing (AGENTS.md); the sign-click is the whole authorization, so there is no
  // consent token. On success the created PR's URL surfaces; on failure the failure
  // surfaces honestly — never a fabricated success.
  async function submitPullRequest(): Promise<void> {
    if (!review || !patchset) return;
    // Re-entry guard: a submit already in flight must not start a second, so a
    // re-render during the async push/create cannot double-push or double-open. The
    // ref is synchronous (state lags a render); the sign control is also disabled via
    // `publishing` below.
    if (publishingRef.current) return;
    // The own-branch outbound artifact is the PR SUBMISSION — the SAME preview the
    // paper shows and the SAME bytes it signs (`publishTargetPayload`), so what leaves
    // is exactly what the human previewed.
    const target = publishTargetForMode;
    if (target.mode !== "own-branch") return;
    const submission = target.submission;
    const payload = publishTargetPayload(target);
    publishingRef.current = true;
    setPublishing(true);
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await bridge.invoke("publish.submitPr", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
        submission: {
          title: submission.title,
          body: submission.body,
          base: submission.base,
          head: submission.head,
          draft: submission.draft,
        },
        payload,
      });
      setPublishResult({
        kind: "submitted",
        url: outcome.url,
        number: outcome.number,
        reused: outcome.reused,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      publishingRef.current = false;
      setPublishing(false);
      setBusy(false);
    }
  }
  // Mode-split the sign so "what you preview is what signs" holds in BOTH modes
  // (issue #109). other-pr previews line-anchored review comments and the wired
  // `publish.review` engine emits exactly those; own-branch previews a PR submission
  // and `submitPullRequest` pushes + opens exactly that.
  function signPaper(): void {
    if (destinationMode === "own-branch") {
      void submitPullRequest();
      return;
    }
    void publishReview();
  }
  const reviewSurfaceIndex = navigation.stack.map((surface) => surface.kind).lastIndexOf("review");
  function returnToReview(): void {
    if (reviewSurfaceIndex >= 0) navigate(ascendNavigationTo(reviewSurfaceIndex));
  }
  // A retrospective review is read-only: the entire sign → collate → publish surface
  // is REPLACED by a plain notice, so there is no affordance to post at all. This is
  // the renderer half of the no-post guarantee; MAIN's `publish.review` refusal is the
  // structural half, so even without this the command cannot egress.
  const destinationChrome = review?.retrospective ? (
    <div className="rennet-glass contents" data-scheme={effectiveScheme}>
      <section
        className="retrospective-notice grid gap-1.5 px-[18px] py-4"
        role="note"
        data-testid="retrospective-notice"
      >
        <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
          RETROSPECTIVE REVIEW
        </p>
        <p className="m-0 text-base leading-normal text-ink">
          Reading an already-merged pull request. Your dispositions stay local — nothing is posted
          back to GitHub.
        </p>
      </section>
    </div>
  ) : (
    <div
      className="rennet-glass contents"
      data-scheme={effectiveScheme}
      {...(currentSurface.kind === "draft" ||
      currentSurface.kind === "paper" ||
      currentSurface.kind === "handoff"
        ? { "data-destination-visible": "" }
        : {})}
    >
      <DestinationFrame
        draft={draft}
        mode={destinationMode}
        onSelectMode={setDestinationMode}
        onOpenDraft={() => {
          if (review) navigate(pushSurface({ kind: "draft", reviewId: review.id }));
        }}
        onHandoff={() => {
          if (review) navigate(pushSurface({ kind: "handoff", reviewId: review.id }));
        }}
      />
      {currentSurface.kind === "draft" ? (
        <CollationDraftCanvas
          draft={draft}
          variant={destinationVariantForMode}
          onChange={handleDraftChange}
          onRefine={(item) => void refineItem(item)}
          onKeepRaw={keepRaw}
          onRefineAll={refineAll}
          refineStates={refineStates}
          prDraft={prDraft}
          onPrDraftChange={setPrDraft}
          onDraftPrBody={() => void draftPrBody()}
          prDraftState={prDraftState}
          onSign={() => {
            // Freezing a fresh paper drops any stale outcome from a prior sign.
            setPublishResult(undefined);
            if (review) navigate(pushSurface({ kind: "paper", reviewId: review.id }));
          }}
          onBack={() => navigate(navigateBack())}
        />
      ) : null}
      {currentSurface.kind === "paper" ? (
        <PublishSheet
          target={publishTargetForMode}
          payload={publishTargetPayload(publishTargetForMode)}
          variant={destinationVariantForMode}
          ledger={publishLedger}
          result={publishResult}
          // A completed sign performs a REAL post only when this review was opened
          // from a real PR (`postTarget` present), is not retrospective, and we are
          // posting the review (other-pr). The flag changes ONLY the pre-sign copy;
          // the actual post is still gated by the consent token minted on sign.
          willPost={
            destinationMode === "other-pr" &&
            review?.retrospective !== true &&
            review?.postTarget !== undefined
          }
          postLabel={review?.postTarget ? previewTargetLabel(review.postTarget) : undefined}
          pending={publishing}
          // Disclose blocked ingestion (R18/#309) from the PATCHSET-BOUND flagged
          // result, so a regenerate-stale result never discloses the wrong patchset's
          // gaps. Render-only honest copy — it never gates the sign (Rule Zero).
          blockingStates={boundFlaggedReview?.blockingStates}
          onBack={() => {
            // Editing lives on the draft; a returned-to edit invalidates the outcome.
            setPublishResult(undefined);
            navigate(navigateBack());
          }}
          onSign={() => signPaper()}
          onClose={() => {
            setPublishResult(undefined);
            returnToReview();
          }}
        />
      ) : null}
      {currentSurface.kind === "handoff" ? (
        // The handoff surface is a MODAL, mounted the same way PublishSheet is: a
        // fixed, full-viewport backdrop (reusing `.publish-sheet-backdrop`) with
        // dialog semantics, so the paper sits OVER the destination frame rather than
        // in document flow beneath a still-active frame. (C4.)
        <div
          className="publish-sheet-backdrop fixed inset-0 z-40 grid place-items-center bg-black/70 p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Handoff"
        >
          {handoffComposed ? (
            <HandoffPaper
              bundle={handoffComposed.bundle}
              runState={handoffRun}
              onRun={() => void runHandoff()}
              onBack={() => navigate(navigateBack())}
            />
          ) : (
            <section
              className="handoff-pending grid gap-4 rounded-window bg-overlay p-6 shadow-overlay"
              role="status"
              data-compose-state={handoffComposeState}
            >
              <button
                type="button"
                className="handoff-paper-back cursor-pointer justify-self-start rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-soft hover:text-ink"
                onClick={() => navigate(navigateBack())}
              >
                Back
              </button>
              {handoffComposeState === "error" ? (
                <p className="handoff-compose-error m-0 text-base text-danger" role="alert">
                  Composing the handoff failed. Go back and reopen, or change a disposition, to try
                  again.
                </p>
              ) : (
                <p className="handoff-composing m-0 text-base text-ink-soft">
                  Composing the handoff…
                </p>
              )}
            </section>
          )}
        </div>
      ) : null}
    </div>
  );

  async function regenerate(): Promise<void> {
    if (!review) return;
    setBusy(true);
    try {
      const result = await bridge.invoke("review.regenerate", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
        repoPath: review.repositoryRoot,
      });
      setReview(result.review);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The draft change handler wired to every edit (#19 invalidation). When any input
   * a refinement is bound to changes — the raw body (reword / merge), the type
   * (retype), the anchor (re-anchor), or the item's existence (withdraw) — its
   * EPHEMERAL refine verdict is stale: a "no-change" / "failed" / "unavailable"
   * message must not linger over a note the model never saw, and because the
   * message branch renders AHEAD of the Refine button, a lingering message also
   * hides the button for the new text. This is the SAME invalidation event as the
   * DURABLE `refined` (which `rewordItem`/`retypeItem` clear); the ephemeral sibling
   * is cleared on the same signal, keyed off the shared `itemRefineSignature`. A
   * pure reorder leaves every signature unchanged, so nothing is dropped.
   */
  function handleDraftChange(next: CollationDraft): void {
    setRefineStates((prev) => {
      let changed = false;
      const kept: Record<string, RefineItemState> = {};
      for (const [id, state] of Object.entries(prev)) {
        const before = draft.find((entry) => entry.id === id);
        const after = next.find((entry) => entry.id === id);
        // Keep a verdict only while its item still exists with the SAME refine inputs.
        if (before && after && itemRefineSignature(before) === itemRefineSignature(after)) {
          kept[id] = state;
        } else {
          changed = true;
        }
      }
      return changed ? kept : prev;
    });
    setDraft(next);
  }

  /** Clear one item's ephemeral refine state (a landed refinement is durable on the item). */
  function clearRefineState(itemId: string): void {
    setRefineStates((prev) => {
      if (prev[itemId] === undefined) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  /**
   * Refine one raw note into a clean comment (#19): mark it refining, run the real
   * council-routed model turn, and round the result back onto the draft. EVERY
   * outcome — refined, no-change, unavailable, failed — is bound to the item's full
   * refine inputs at request time (`itemRefineSignature`: raw + type + anchor) and
   * DROPPED if any of them changed while the turn ran, so a verdict for a note the
   * model never saw is never shown or adopted. A surviving outcome is surfaced
   * HONESTLY; the sovereign raw stays the effective body unless a refinement lands.
   */
  async function refineItem(item: CollationItem): Promise<void> {
    if (!review || item.raw.trim() === "") return;
    const basedOn = itemRefineSignature(item);
    // The outcome is stale once the item's refine inputs have changed since the turn
    // began (reword / retype / re-anchor), or the item is gone. `draftRef` reads the
    // LATEST draft; the closure `item` is the request-time snapshot.
    const isStale = (): boolean => {
      const current = draftRef.current.find((entry) => entry.id === item.id);
      return current === undefined || itemRefineSignature(current) !== basedOn;
    };
    setRefineStates((prev) => ({ ...prev, [item.id]: { status: "refining" } }));
    try {
      const result = await bridge.invoke("review.refine", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
        itemId: item.id,
        type: item.type,
        raw: item.raw,
        lens: canvasAngle,
        path: item.path,
        // The anchor (#78) rides along so the producer grounds against the RIGHT
        // hunk, not a truncation from the file's start (the Codex grounding catch).
        ...(item.span === undefined ? {} : { span: item.span }),
        ...(item.side === undefined ? {} : { side: item.side }),
      });
      if (isStale()) {
        // The note changed or was withdrawn mid-turn — drop the outcome entirely and
        // return the item to idle for its NEW content.
        clearRefineState(item.id);
        return;
      }
      if (result.status === "refined") {
        setDraft((current) => setRefined(current, item.id, result.refined));
        clearRefineState(item.id);
      } else if (result.status === "no-change") {
        setRefineStates((prev) => ({ ...prev, [item.id]: { status: "no-change" } }));
      } else if (result.status === "unavailable") {
        setRefineStates((prev) => ({
          ...prev,
          [item.id]: { status: "unavailable", reason: result.reason },
        }));
      } else {
        setRefineStates((prev) => ({
          ...prev,
          [item.id]: { status: "failed", reason: result.reason },
        }));
      }
    } catch (err) {
      // A comms failure is also stale-gated: don't pin "failed" onto a note that has
      // since changed (the message would sit over text the turn never concerned).
      if (isStale()) {
        clearRefineState(item.id);
        return;
      }
      setRefineStates((prev) => ({
        ...prev,
        [item.id]: { status: "failed", reason: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  /** Keep the original note, dropping a landed refinement (#19 — the undo). */
  function keepRaw(item: CollationItem): void {
    setDraft((current) => clearRefined(current, item.id));
    clearRefineState(item.id);
  }

  /**
   * Refine every refinable, not-yet-refined, not-in-flight item — BOUNDED (#19).
   * Each refine is a real model turn (a `codex exec` / Claude subprocess), so
   * firing all of a large draft at once is real resource pressure; `runBatched`
   * caps the fan-out to `REFINE_CONCURRENCY` at a time. The staleness gate in
   * `refineItem` still handles a note edited between click and its batch.
   */
  async function refineAll(): Promise<void> {
    const eligible = draft.filter(
      (item) =>
        item.raw.trim() !== "" &&
        item.refined === undefined &&
        refineStates[item.id]?.status !== "refining",
    );
    await runBatched(eligible, REFINE_CONCURRENCY, (item) => refineItem(item));
  }

  /**
   * Draft the PR title + body from the reviewed changeset (issue #74, M26). Hands the
   * live producer the material the renderer already holds — the branch shape, the
   * roll-up narration (when narrated), the staged dispositions' resolutions, and the
   * spec angle's requirements — and rounds the drafted title+body into the editable
   * composer (the human then edits; their version is what the paper previews). A
   * failed/unavailable turn leaves the fields untouched and shows the honest state;
   * the deterministic composed body still previews on the paper. Posts NOTHING.
   */
  async function draftPrBody(): Promise<void> {
    if (!review) return;
    // Claim a generation for THIS turn; a newer draft or a review switch bumps the
    // ref, so a stale result is dropped on arrival rather than applied (#74 HIGH-2).
    prDraftGeneration.current += 1;
    const generation = prDraftGeneration.current;
    setPrDraftState({ status: "drafting" });
    // The dispositions the reviewer STAGED (the ink subset), reduced to what the
    // account reasons over: type + path + the effective body (refined once #19
    // landed, else the raw note). ⭐ This MUST be `inkDraft`, never the full `draft`:
    // a BLUE (unstaged, local-only) disposition is private reviewer reasoning that
    // "stays on this machine and never leaves" (staging.ts contract). Drafting sends
    // these to a Claude/Codex harness, so an unstaged blue note in the input would
    // egress private notes AND could be woven into the posted PR body — the exact
    // leak #74's HIGH-1 named. `inkDraft = publishedItems(draft)` is the same subset
    // the paper previews and the sign wire posts, so what the model sees is exactly
    // what would publish.
    const dispositions = inkDraft.map((item) => ({
      type: item.type,
      path: item.path,
      resolution: effectiveBody(item),
    }));
    // The spec angle's requirements (the SHALL statements the change was meant to
    // satisfy), flattened from the parsed OpenSpec change the Spec lens loaded.
    const requirements = (openSpecChange?.specDeltas ?? []).flatMap((delta) =>
      delta.groups.flatMap((group) =>
        group.requirements.map((requirement) => requirement.statement),
      ),
    );
    // The roll-up narration (M22), when one was actually narrated — the changeset's
    // own voice. A pending/failed placement carries no account, so it is omitted.
    const rollup = narration?.rollup;
    const narrationInput =
      rollup?.status === "narrated"
        ? { oneLine: rollup.oneLine, paragraph: rollup.paragraph }
        : undefined;
    try {
      const result = await bridge.invoke("review.draftPrBody", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
        base: publishContext.submission.base,
        head: publishContext.submission.head,
        dispositions,
        ...(narrationInput === undefined ? {} : { narration: narrationInput }),
        ...(requirements.length === 0 ? {} : { requirements }),
      });
      // Drop a superseded result (#74 HIGH-2): a newer draft or a review switch bumped
      // the generation while this turn was in flight, so applying its title/body would
      // overwrite a composer that has since moved on.
      if (generation !== prDraftGeneration.current) return;
      if (result.status === "drafted") {
        // The draft lands in the editable fields; the human's edit is final from here.
        setPrDraft({ title: result.title, body: result.body });
        setPrDraftState({ status: "drafted", model: result.model });
      } else if (result.status === "unavailable") {
        setPrDraftState({ status: "unavailable", reason: result.reason });
      } else {
        setPrDraftState({ status: "failed", reason: result.reason });
      }
    } catch (err) {
      // Same staleness gate on the failure path — a superseded turn must not pin a
      // "failed" status onto a composer that has moved to another review/draft.
      if (generation !== prDraftGeneration.current) return;
      setPrDraftState({
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function goToProjects(): void {
    setDirectEntryOpen(false);
    navigate(ascendNavigationTo(0));
  }

  // Load a project's detail substrate + its row in the projects list (issue #37),
  // shared by the palette's `goToRecent` and the landing rehydrator (#324). Throws if
  // the project is no longer available, so the rehydrator can floor honestly.
  async function loadProjectDetail(projectId: string): Promise<void> {
    const detail = await bridge.invoke("project.detail", { projectId });
    const { projects } = await bridge.invoke("projects.list", {});
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project ${projectId} is no longer available.`);
    setProjectDetail(project);
    setProjectDetailData(detail);
  }

  async function goToRecent(surface: RecentSurface): Promise<void> {
    if (surface.kind === "projects") {
      goToProjects();
      return;
    }

    setError(undefined);
    try {
      await loadProjectDetail(surface.projectId);
      setDirectEntryOpen(false);
      navigate(ascendNavigationTo(0));
      navigate(pushSurface(surface));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const projectSurfaceIndex = navigation.stack
    .map((surface) => surface.kind)
    .lastIndexOf("project");
  const surfaceLabels: SurfaceLabels = {
    project: (id) => (projectDetail?.id === id ? projectDetail.name : undefined),
    review: (id) => (review?.id === id ? review.repositoryRoot : undefined),
  };
  function goToProject(): void {
    if (projectSurfaceIndex < 0) return;
    setDirectEntryOpen(false);
    navigate(ascendNavigationTo(projectSurfaceIndex));
  }
  function goToDraft(): void {
    if (!review || review.retrospective) return;
    const draftIndex = navigation.stack.map((surface) => surface.kind).lastIndexOf("draft");
    if (draftIndex >= 0) {
      navigate(ascendNavigationTo(draftIndex));
      return;
    }
    navigate(pushSurface({ kind: "draft", reviewId: review.id }));
  }
  function goToPaper(): void {
    if (!review || review.retrospective || currentSurface.kind === "paper") return;
    if (currentSurface.kind === "review") {
      navigate(pushSurface({ kind: "draft", reviewId: review.id }));
    }
    navigate(pushSurface({ kind: "paper", reviewId: review.id }));
  }

  // Which top-level surface is showing — mirrors the surface at the stack's tip,
  // so the palette offers exactly the commands live for the current screen.
  const screen: Screen | null =
    review === undefined
      ? null
      : directEntryOpen
        ? "directEntry"
        : currentSurface.kind === "projects"
          ? "frontDoor"
          : currentSurface.kind === "project"
            ? "projectDetail"
            : "workspace";
  // The lens/zoom/scheme commands act on the live store, so they are only offered
  // while the Canvases view is actually showing a loaded review.
  const canvasReady = view === "canvases" && liveLoaded && canvases !== null;
  const commandContext: CommandContext | null = screen
    ? {
        screen,
        surfaceKind: currentSurface.kind,
        currentSurface,
        recents,
        surfaceLabels,
        canBack: navigation.stack.length > 1,
        canForward: navigation.future.length > 0,
        canGoToProject: projectSurfaceIndex >= 0,
        retrospective: review?.retrospective === true,
        canvasReady,
        view,
        deepReviewOn,
        overlayOn: canvasOverlayOn,
        scheme: canvasScheme,
        angle: canvasAngle,
        zoomLevel: canvasZoomLevel,
        back: goBack,
        forward: goForward,
        goToProjects,
        goToProject,
        goToDraft,
        goToPaper,
        goToRecent: (surface) => void goToRecent(surface),
        openSettings: () => setSettingsOpen(true),
        showFiles: () => setView("review"),
        showCanvases: () => setView("canvases"),
        reviewDirectly: () => setDirectEntryOpen(true),
        chooseRepository: () => void chooseRepository(),
        retryReview: retryLiveLoad,
        regenerate: () => void regenerate(),
        toggleDeepReview: () => {
          if (reviewId) setDeepReviewChoice({ reviewId, on: !deepReviewOn });
        },
        goToAngle: (angle) => viewStore.getState().setAngle(angle),
        zoomIn: () =>
          viewStore.getState().setZoom(zoomReducer(viewStore.getState().zoom, { type: "zoomIn" })),
        zoomOut: () =>
          viewStore.getState().setZoom(zoomReducer(viewStore.getState().zoom, { type: "zoomOut" })),
        toggleOverlay: () => viewStore.getState().toggleOverlay(),
        toggleScheme: () => {
          const state = viewStore.getState();
          state.setScheme(state.scheme === "dark" ? "light" : "dark");
        },
      }
    : null;
  const builtCommands = commandContext ? buildCommands(commandContext) : [];
  // The palette-toggle is a registry command whose `run` is supplied here (like every
  // other handler). It is not emitted into the palette list itself, but it joins the
  // dispatch list so its ⌘K chord (remappable) routes through the same matcher.
  const paletteCommand: Command = commandFromCatalogue(
    "palette.toggle",
    commandContext ?? undefined,
    () => setPaletteOpen((open) => !open),
  );
  const dispatchCommands = [paletteCommand, ...builtCommands];
  // Publish the live dispatch list for the stable window keydown listener (above).
  dispatchRef.current = { commands: dispatchCommands, overrides: keybindingOverrides };

  // Host-app update readiness → badge on the chrome marks. Hosts without an
  // updater omit the member and this is a no-op (spec: desktop-update-notification).
  useEffect(() => {
    return bridge.onUpdateReady?.((info) => {
      useUpdateReady.getState().markReady(info);
    });
  }, [bridge]);
  const updatePrompt = <UpdateReadyPrompt onApply={() => bridge.applyUpdate?.()} />;

  const palette = (
    <CommandPalette
      open={paletteOpen}
      commands={builtCommands}
      overrides={keybindingOverrides}
      onClose={() => setPaletteOpen(false)}
    />
  );

  function navigationSurface(content: ReactNode): ReactNode {
    const inReview =
      currentSurface.kind === "review" ||
      currentSurface.kind === "draft" ||
      currentSurface.kind === "paper" ||
      currentSurface.kind === "handoff";
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          {/* History is a paired control: the rail is gone, back/forward live here. */}
          <div className="navigation-history flex flex-none items-center gap-0.5">
            <button
              type="button"
              className="navigation-history-button flex size-8 items-center justify-center rounded-control text-ink-soft hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-35"
              aria-label="Back"
              title="Back"
              disabled={navigation.stack.length <= 1}
              onClick={goBack}
            >
              <ArrowLeftIcon size={16} />
            </button>
            <button
              type="button"
              className="navigation-history-button flex size-8 items-center justify-center rounded-control text-ink-soft hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-35"
              aria-label="Forward"
              title="Forward"
              disabled={navigation.future.length === 0}
              onClick={goForward}
            >
              <ArrowRightIcon size={16} />
            </button>
          </div>
          <Breadcrumb
            crumb={deriveCrumb(navigation.stack, surfaceLabels)}
            onAscend={(index) => {
              setDirectEntryOpen(false);
              navigate(ascendNavigationTo(index));
            }}
          />
          {inReview && patchset ? (
            <div className="navigation-titlebar-context ml-auto flex items-center gap-2">
              <span className="navigation-mode-pill rounded-chip border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink-soft">
                {deepReviewOn ? "Dual review" : "Quick review"}
              </span>
              <code
                className="navigation-patchset-chip rounded-chip border border-line bg-surface px-2.5 py-1 font-mono text-xs text-ink-soft"
                title={patchset.id}
              >
                {patchset.id.slice(0, 12)}
              </code>
            </div>
          ) : null}
          {inReview && review && !review.retrospective ? (
            <button
              type="button"
              className="navigation-draft-cta inline-flex cursor-pointer items-center gap-2 rounded-control bg-accent-fill px-3.5 py-1.5 text-sm font-semibold text-accent-ink"
              onClick={() => navigate(pushSurface({ kind: "draft", reviewId: review.id }))}
            >
              {draft.length > 0 ? (
                <span className="navigation-draft-count inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent-ink px-1 text-2xs font-bold text-accent-fill">
                  {draft.length}
                </span>
              ) : null}
              Preview
              <ArrowRightIcon size={12} />
            </button>
          ) : null}
          {connectionSlot}
        </header>
        <div className="navigation-surface-content min-h-screen pt-14">{content}</div>
      </div>
    );
  }

  if (review === undefined) {
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        {updatePrompt}
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          <Breadcrumb crumb={deriveCrumb([{ kind: "projects" }])} onAscend={() => undefined} />
          {connectionSlot}
        </header>
        <div className="navigation-surface-content min-h-screen pt-14">
          <div className="loading px-8 py-10 font-serif text-base text-ink-soft">
            Restoring local review…
          </div>
        </div>
      </div>
    );
  }

  // Settings and direct entry are orbital overlays. They take render precedence but
  // never mutate the surface stack, so closing either reveals the exact location.
  // Both keep the standard titlebar: on macOS's hiddenInset frame it is the ONLY
  // drag surface, and it reserves the traffic-light inset (review finding: without
  // it these screens made the window immovable).
  if (settingsOpen) {
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        {updatePrompt}
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          <span className="text-sm text-ink-soft">Settings</span>
        </header>
        {error ? (
          <div className="error-toast fixed left-1/2 top-16 z-30 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        <div className="navigation-surface-content min-h-screen pt-14">
          <SettingsScreen
            bridge={bridge}
            scheme={effectiveScheme}
            onBack={() => setSettingsOpen(false)}
            onSchemeChange={setScheme}
            onKeybindingsChange={setKeybindingOverrides}
          />
        </div>
      </div>
    );
  }

  if (directEntryOpen) {
    return (
      <div className="navigation-shell min-h-screen bg-canvas text-ink">
        {palette}
        {updatePrompt}
        <header className="navigation-titlebar fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 [[data-platform=darwin]_&]:pl-20">
          <ChromeMenu
            size={16}
            className="navigation-titlebar-mark flex flex-none items-center opacity-80"
            version={bridge.version}
            canBackToProjects={currentSurface.kind !== "projects"}
            onOpenSettings={() => setSettingsOpen(true)}
            onBackToProjects={() => {
              setSettingsOpen(false);
              goToProjects();
            }}
          />
          <button
            type="button"
            className="entry-back inline-flex cursor-pointer items-center gap-1.5 rounded-control border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink-soft hover:text-ink"
            onClick={() => setDirectEntryOpen(false)}
          >
            <ArrowLeftIcon size={13} />
            Back
          </button>
        </header>
        <main className="empty-state grid min-h-screen place-content-center justify-items-center bg-canvas p-8 pt-22 text-center">
          <div
            className="mark mb-4 grid size-[54px] place-items-center rounded-window border border-accent-line bg-accent-soft text-accent -rotate-[4deg]"
            aria-hidden="true"
          >
            <RennetBrandMark size={26} />
          </div>
          <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            RENNET
          </p>
          <h1 className="my-2.5 max-w-[620px] font-display text-display font-medium tracking-tight text-ink">
            Start a review.
          </h1>
          <p className="max-w-[560px] leading-relaxed text-ink-soft">
            Capture local git changes into one patchset.
          </p>
          <button
            type="button"
            className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-control bg-accent-fill px-4 py-3 font-semibold text-accent-ink disabled:cursor-wait disabled:opacity-60"
            disabled={busy}
            onClick={chooseRepository}
          >
            <FolderIcon size={15} />
            {busy ? "Working…" : "Choose a repository"}
          </button>

          <div
            className="entry-divider mb-1 mt-6 flex w-[min(440px,82vw)] items-center gap-3 text-xs uppercase tracking-wide text-ink-faint before:h-px before:flex-1 before:bg-line before:content-[''] after:h-px after:flex-1 after:bg-line after:content-['']"
            aria-hidden="true"
          >
            <span>or a pull request</span>
          </div>

          <form
            className="pr-door mt-3.5 flex w-[min(440px,82vw)] flex-wrap gap-2"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              void openPullRequest();
            }}
          >
            <input
              type="text"
              className="pr-input min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-3 py-2.5 font-mono text-base text-ink placeholder:text-ink-faint"
              value={prRef}
              onChange={(inputEvent) => setPrRef(inputEvent.target.value)}
              placeholder="owner/repo#42  or  a GitHub PR URL"
              aria-label="Pull request reference"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={busy}
            />
            <button
              type="submit"
              className={`${SECONDARY_BUTTON} whitespace-nowrap`}
              disabled={busy || prRef.trim().length === 0}
            >
              {busy ? "Opening…" : "Open pull request"}
            </button>
            <label className="pr-retrospective flex basis-full cursor-pointer items-start gap-2 text-left text-xs leading-snug text-ink-faint">
              <input
                type="checkbox"
                className="mt-0.5 flex-none"
                checked={prRetrospective}
                onChange={(inputEvent) => setPrRetrospective(inputEvent.target.checked)}
                disabled={busy}
              />
              <span>Retrospective review — read an already-merged PR. Nothing is posted back.</span>
            </label>
          </form>
          <p className="pr-hint mt-2.5 text-xs text-ink-faint">
            No clone needed — Rennet fetches the repository itself.
          </p>

          {error ? <p className="error text-danger">{error}</p> : null}
        </main>
      </div>
    );
  }

  // While a landed surface's content rehydrates (#324/#297) — its held review or
  // cached project detail does not yet match the tip — show the loading treatment
  // under the tip's OWN crumb. Never fall through to render another surface's content
  // under this crumb (the exact #305 regression class the spec forbids).
  const reviewTipId =
    currentSurface.kind === "review" ||
    currentSurface.kind === "draft" ||
    currentSurface.kind === "paper" ||
    currentSurface.kind === "handoff"
      ? currentSurface.reviewId
      : undefined;
  const surfaceRehydrating =
    (currentSurface.kind === "project" && projectDetail?.id !== currentSurface.projectId) ||
    (reviewTipId !== undefined && review?.id !== reviewTipId);
  if (surfaceRehydrating) {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        <div className="loading px-8 py-10 font-serif text-base text-ink-soft">Reopening…</div>
      </>,
    );
  }

  // Project detail (issue #37): clicking a project row opens its unified smart list —
  // local work + every PR in one surface. Its payload stays cached while a child
  // review is open, so Back can reveal this exact parent surface without refetching.
  if (currentSurface.kind === "project" && projectDetail?.id === currentSurface.projectId) {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        {busy ? (
          <div className="busy-bar fixed left-0 top-0 z-[11] h-0.5 w-[35%] bg-accent-fill" />
        ) : null}
        <ProjectDetail
          key={projectDetail.id}
          bridge={bridge}
          project={projectDetail}
          initialDetail={projectDetailData ?? undefined}
          scheme={effectiveScheme}
          onOpenRow={(row) => void openRow(projectDetail, row)}
          onOpenContextMap={() =>
            navigate(pushSurface({ kind: "contextMap", projectId: projectDetail.id }))
          }
          onBack={() => navigate(navigateBack())}
        />
        {palette}
        {updatePrompt}
      </>,
    );
  }

  // The Context Map surface (change add-context-map-view): a per-project view of the
  // Repo Map — structure, the knowledge layer, and a project-scoped ask rail. Self-
  // loading over `project.contextMap`; an absent snapshot is stated plainly.
  if (currentSurface.kind === "contextMap") {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        <ContextMapView
          key={currentSurface.projectId}
          bridge={bridge}
          projectId={currentSurface.projectId}
          onBack={() => navigate(navigateBack())}
        />
        {palette}
        {updatePrompt}
      </>,
    );
  }

  // The front door is the root surface. Direct entry remains available through the
  // palette, but no longer has a drawn door on this surface.
  if (currentSurface.kind === "projects" || !review) {
    return navigationSurface(
      <>
        {error ? (
          <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : null}
        {busy ? (
          <div className="busy-bar fixed left-0 top-0 z-[11] h-0.5 w-[35%] bg-accent-fill" />
        ) : null}
        <FrontDoor
          bridge={bridge}
          onOpenProject={(project) => {
            setProjectDetail(project);
            setProjectDetailData(null);
            navigate(pushSurface({ kind: "project", projectId: project.id }));
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          scheme={effectiveScheme}
        />
        {palette}
        {updatePrompt}
      </>,
    );
  }

  return navigationSurface(
    <>
      {error ? (
        <div className="error-toast fixed left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-control border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {busy ? (
        <div className="busy-bar fixed left-0 top-0 z-[11] h-0.5 w-[35%] bg-accent-fill" />
      ) : null}
      {/* The worktree-gone status (#324): a reopened review whose original repository
          root no longer exists shows the persisted review as captured, plainly stated.
          Informational — it blocks nothing (Rule Zero); the files, dispositions, and
          delta account below all render from persisted state. */}
      {!repositoryPresent ? (
        <div
          className="worktree-gone-status border-b border-line bg-surface px-6 py-3 text-sm text-ink-soft"
          role="status"
        >
          The original worktree is gone — showing the review as captured.
        </div>
      ) : null}
      {/* The delta re-review account (issue #73): at the TOP of a successor review,
          before the view tabs, stating what the returned patchset did to each ask and
          what it changed beyond them. Present only on a successor (a regenerate that
          carried asks); absent on a first capture. Informational — gates nothing.
          Anchoring an item opens the Files view on that path and focuses its carried
          span when the account names one. */}
      {review?.deltaAccount ? (
        <DeltaAccountPanel
          account={review.deltaAccount}
          digest={deltaDigest}
          onAnchor={(path, span, side) => {
            setView("review");
            setSelectedPath(path);
            if (span === undefined) {
              setDiffFocus(undefined);
              return;
            }
            diffFocusNonce.current += 1;
            setDiffFocus({
              path,
              span,
              ...(side !== undefined ? { side } : {}),
              nonce: diffFocusNonce.current,
            });
          }}
        />
      ) : null}
      {/* The composition inspector (issue #30): the REAL manifest of the context
          Rennet assembled for this review — documents in composition order, hashes, byte
          counts, truncation state, and the assembled-prompt digest. Present ONLY when
          a real manifest came back; absent ⇒ nothing renders (honest not-available,
          never a fabricated stand-in). Informational and gate-free (Rule Zero). */}
      {shownContextManifest ? <ContextManifestPanel manifest={shownContextManifest} /> : null}
      <div
        className="view-toggle fixed right-4 top-3 z-[21] inline-flex items-center gap-1.5"
        role="tablist"
        aria-label="Workspace view"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "review"}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold ${view === "review" ? "is-active border-accent-line bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:text-ink"}`}
          onClick={() => setView("review")}
        >
          <FileDiffIcon size={13} />
          Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "canvases"}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-control border px-3 py-1.5 text-xs font-semibold ${view === "canvases" ? "is-active border-accent-line bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:text-ink"}`}
          onClick={() => setView("canvases")}
        >
          <LayersIcon size={13} />
          Canvases
        </button>
      </div>
      {view === "canvases" ? (
        liveLoaded && canvases ? (
          <>
            {/* The loud fallback (real-AI-default): when no model ran, say so at the
                top of the review — never let the mechanical outline pass as AI. */}
            {engine && !engine.aiReview ? (
              <div
                className="engine-fallback flex items-center gap-4 border-b border-accent-line bg-accent-surface py-3 pl-5 pr-[300px]"
                role="alert"
              >
                <TriangleIcon size={18} className="engine-fallback-icon flex-none text-accent" />
                <div className="engine-fallback-copy flex min-w-0 flex-1 flex-col gap-0.5">
                  <strong className="text-base font-semibold text-ink">
                    {mechanicalFallbackTitle(engine)}
                  </strong>
                  <span className="text-sm leading-normal text-ink opacity-85">
                    {mechanicalFallbackDetail(engine)}
                  </span>
                </div>
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON} flex-none`}
                  onClick={retryLiveLoad}
                >
                  Retry the AI review
                </button>
              </div>
            ) : null}
            {/* The review-heart split (issue #36): the diff column and the
                conversation margin are FLEX SIBLINGS, so opening or growing a thread
                changes only the margin — the diff column is a fixed point that never
                reflows. This is the shipped structure the `.review-heart-split` /
                `.diff-column` contract needs; without it the margin stacked below. */}
            <div className="review-heart-split flex items-start gap-4">
              <div className="diff-column min-w-0 flex-1">
                <CanvasWorkspace
                  store={viewStore}
                  canvases={canvases}
                  // Keybinding overrides (#44) so a `zoom.in`/`zoom.out` remap takes
                  // effect on the canvas keys too, not just in the palette label.
                  keybindingOverrides={keybindingOverrides}
                  // The live review identity (issue #240): the workspace stays mounted
                  // across reviews, so its per-review hypothesis-frame collapse state is
                  // keyed by this id rather than leaking A's choice into B.
                  reviewId={reviewId}
                  bridge={bridge}
                  scheme={effectiveScheme}
                  narration={narration}
                  flaggedReview={boundFlaggedReview}
                  deepReview={{
                    active: deepReviewOn,
                    // The opt-down/opt-up choice is stamped with THIS review's id, so it
                    // applies only here and a later review reads the dual default.
                    onToggle: () => {
                      if (reviewId) setDeepReviewChoice({ reviewId, on: !deepReviewOn });
                    },
                  }}
                  noiseReview={boundNoiseReview}
                  // The verify-ui screenshot loader (issue #183): each captured
                  // screenshot loads on demand over the `review.uiEvidence` command, so
                  // the bytes never ride the flagged payload. A not-found (moved store,
                  // escaping path) maps to null → the strip shows a missing-evidence
                  // note. Live once a review has loaded; absent → the strip shows no
                  // thumbnails.
                  loadUiEvidence={
                    review
                      ? async (path) => {
                          const result = await bridge.invoke("review.uiEvidence", {
                            reviewId: review.id,
                            path,
                          });
                          return result.status === "ok" ? result.dataUrl : null;
                        }
                      : undefined
                  }
                  // The Decisions runner's status (issue #137/#160): when the runner
                  // FAILED, the Decisions lens paints the failed banner instead of
                  // conflating a crashed pass with "no decisions". Absent ⇒ `ok`.
                  decisionsRunStatus={decisionsRun}
                  // The Spec angle's structured OpenSpec viewer (Rai, wireframes #9), LIVE:
                  // parse-on-open of the change the reviewed patchset selected, over the real
                  // command boundary (`openspec.change`). Undefined when the review touches no
                  // change — the Spec angle then shows its honest empty state, never a fixture.
                  openSpecChange={openSpecChange}
                  // The produced requirement→hunk coverage (wireframes #9 / R53): present
                  // only when the mapping ran; absent ⇒ the Spec view renders no chips.
                  openSpecCoverage={openSpecCoverage}
                  onDispositions={(writes) => {
                    setCanvases((current) => (current ? applyWrites(current, writes) : current));
                    // dispose == staged: authoring a disposition collates it into the draft
                    // in the same act (upsert-by-path, one act ingests all its fan-out writes).
                    setDraft((current) => ingestWrites(current, writes));
                  }}
                  onAdjudicate={(adjudication) =>
                    setCanvases((current) =>
                      current ? resolveProposal(current, adjudication.proposalId) : current,
                    )
                  }
                  // Real code on the real path (issue #60): the workspace only renders
                  // once a live set has loaded, so zoom reads the real per-element diff
                  // (a doc-anchored element with no entry → the zoom surface renders
                  // nothing, never a fixture).
                  diffFor={(elementKey) => elementDiffs[elementKey]}
                  // The symbol inspector (Rai, wireframes #8): clicking a code identifier
                  // resolves it over the review's model-free symbolic surface, and the
                  // inspector's sites open in the editor. Both are live once a review has
                  // loaded; absent → identifiers stay inert.
                  symbolLookup={
                    review
                      ? (name) =>
                          bridge.invoke("review.symbolLookup", { reviewId: review.id, name })
                      : undefined
                  }
                  onOpenInEditor={
                    review
                      ? (path, line) => {
                          void bridge.invoke("review.openInEditor", {
                            reviewId: review.id,
                            path,
                            line,
                          });
                        }
                      : undefined
                  }
                  // The inline conversation cluster (issue #36): a discuss glyph on a
                  // diff line (plain-click), a range (shift-click), or the chunk header
                  // opens a private thread in the right-margin sibling column, so the diff
                  // column never reflows. Each click is its OWN request (a fresh occurrence
                  // id), so a second discussion on the same line opens a real second thread
                  // rather than being collapsed — the host dedups on the id, not the key.
                  onDiscuss={
                    review
                      ? (anchor) =>
                          setDiscussRequests((current) => [
                            ...current,
                            { id: crypto.randomUUID(), anchor },
                          ])
                      : undefined
                  }
                  agentFocus={agentFocus}
                  onAgentFocusConsumed={consumeAgentFocus}
                  onSpanSelect={(selection) => setSpanSelection(selection ?? undefined)}
                  // Expose the diff scroll container (issue #356) so the conversation
                  // column's rail aligns each thread panel to the row it discusses. The
                  // callback routes the element identity through state (see `diffScrollEl`).
                  diffScrollRef={setDiffScrollEl}
                />
              </div>
            </div>
          </>
        ) : !repositoryPresent ? (
          // The repo is gone (#324): the live AI review needs the original working
          // tree to run, so it is honestly unavailable — never a doomed load, never a
          // demo. The captured Files, dispositions, and delta account remain fully
          // readable (the review surface above renders them from persisted state).
          <section
            className="canvas-primer mx-auto my-[72px] flex max-w-[540px] flex-col items-start gap-2.5 p-7"
            role="status"
          >
            <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              AI REVIEW
            </p>
            <h2 className="m-0 font-display text-xl font-medium text-ink">
              The live review needs the original repository.
            </h2>
            <p className="m-0 text-base leading-normal text-ink-soft">
              The worktree this review was captured from is gone, so the AI review can't run. The
              captured diff and your dispositions are all still here.
            </p>
          </section>
        ) : loadFailed ? (
          <section
            className="canvas-primer mx-auto my-[72px] flex max-w-[540px] flex-col items-start gap-2.5 p-7"
            role="alert"
          >
            <p className="eyebrow m-0 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
              AI REVIEW
            </p>
            <h2 className="m-0 font-display text-xl font-medium text-ink">The review failed.</h2>
            <p className="m-0 text-base leading-normal text-ink-soft">
              The engine returned nothing.
            </p>
            <button
              type="button"
              className="mt-1.5 inline-flex cursor-pointer items-center gap-2 rounded-control bg-accent-fill px-4 py-2.5 font-semibold text-accent-ink"
              onClick={retryLiveLoad}
            >
              Try again
            </button>
          </section>
        ) : (
          <>
            <div
              className="ai-loading-bar relative flex h-7 items-center gap-2.5 overflow-hidden border-b border-line bg-accent-soft px-5 text-xs font-semibold text-accent"
              role="status"
            >
              <span className="ai-loading-bar-fill absolute left-0 top-0 h-full w-[35%] bg-accent-fill opacity-[0.08]" />
              <span className="ai-loading-bar-label relative">AI review loading…</span>
            </div>
            <ReviewWorkspace
              review={review}
              selectedPath={selectedPath}
              focus={diffFocus}
              angleRail={angleRailRows({
                repositoryPresent,
                loadFailed: false,
                canvases: null,
                decisionsRun: undefined,
                flagged: undefined,
                noise: undefined,
              })}
              outlineFallback={false}
              onOpenAngle={(angle) => {
                viewStore.getState().setAngle(angle);
              }}
              onSelectPath={(path) => {
                setSelectedPath(path);
                setDiffFocus(undefined);
              }}
              onSetRead={(path, read) => void setFileRead(path, read)}
              onRegenerate={() => void regenerate()}
            />
          </>
        )
      ) : (
        <ReviewWorkspace
          review={review}
          selectedPath={selectedPath}
          focus={diffFocus}
          // The Angles rail reads the SAME state the Canvases view renders from
          // (critique P2): the loaded canvas set, the decisions-run status, and the
          // flagged/noise fetch results — so what it shows is what actually ran.
          // Every canvas-derived input is bound to the CURRENT review identity
          // (`canvasSetCurrent`, and the key-stamped `loadFailed`): a regenerate or
          // review switch on the Files view renders the honest pending state, never
          // the superseded set's counts/fallback/failure. The flagged/noise rows
          // are patchset-bound by their own machinery (`boundFlaggedReview` /
          // `boundNoiseReview`).
          angleRail={angleRailRows({
            repositoryPresent,
            loadFailed: loadFailed !== false && loadFailed === canvasFetchKey,
            canvases: canvasSetCurrent && liveLoaded ? canvases : null,
            decisionsRun: canvasSetCurrent ? decisionsRun : undefined,
            flagged: boundFlaggedReview,
            noise: boundNoiseReview,
          })}
          outlineFallback={canvasSetCurrent && liveLoaded && engine?.aiReview === false}
          onOpenAngle={(angle) => {
            viewStore.getState().setAngle(angle);
            setView("canvases");
          }}
          onSelectPath={(path) => {
            setSelectedPath(path);
            setDiffFocus(undefined);
          }}
          onSetRead={(path, read) => void setFileRead(path, read)}
          onRegenerate={() => void regenerate()}
        />
      )}
      {/* Frame 06's unified conversation (wireframe #06): always alongside the diff,
          regardless of which view (Files or Canvases) is active. The conversation
          column is a persistent right sidebar — not gated on the canvases loading. */}
      {review && patchset ? (
        <ConversationPanel
          key={review.id}
          bridge={bridge}
          reviewId={review.id}
          anchors={patchset.files.map(
            (file): ConversationAnchor => ({
              kind: "chunk",
              label: file.path,
              key: chunkAnchorKey(file.path),
              path: file.path,
            }),
          )}
          autoOpenRequests={discussRequests}
          selection={spanSelection}
          diffRef={diffScrollRef}
        />
      ) : null}
      {review ? (
        <PrWorktreeStatus bridge={bridge} reviewId={review.id} scheme={effectiveScheme} />
      ) : null}
      {destinationChrome}
      {palette}
      {updatePrompt}
    </>,
  );
}
