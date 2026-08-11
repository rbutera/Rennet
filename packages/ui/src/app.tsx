import {
  type AppearanceScheme,
  openSpecRequirementCoverageKey,
  type Project,
  type RennetBridge,
} from "@rennet/protocol";
import type {
  CanvasAngle,
  DecisionsRunStatus,
  ElementDiffs,
  FlaggedReview,
  NoiseReview,
  OpenSpecChange,
  OpenSpecCoverage,
  Patchset,
  Review,
  ReviewEngine,
  ReviewNarration,
} from "@rennet/types";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CollationDraft,
  type CollationItem,
  clearRefined,
  ingestWrites,
  setRefined,
  withdrawPath,
} from "./canvas/collation";
import type { ConversationAnchor } from "./canvas/conversation";
import { type DestinationMode, destinationVariant, type PublishLedger } from "./canvas/destination";
import { flaggedForPatchset } from "./canvas/flagged";
import { type CanvasSet, loadCanvases } from "./canvas/load";
import { type DispositionWrite, withoutProposal, zoomReducer } from "./canvas/logic";
import type { OpenSpecCoverageIndex } from "./canvas/openspec";
import {
  deriveReviewEvent,
  type PublishContext,
  previewPublishTarget,
  previewTargetLabel,
  publishTarget,
  publishTargetPayload,
  reviewComments,
  reviewCommentsPayload,
} from "./canvas/publish";
import { publishedItems } from "./canvas/staging";
import { createViewStore, useViewStore } from "./canvas/store";
import { buildCommands, type CommandContext, type Screen } from "./command/commands";
import { AskPanel } from "./components/ask-panel";
import { CollationDraftCanvas, type RefineItemState } from "./components/collation-draft-canvas";
import { CommandPalette } from "./components/command-palette";
import { ConversationHost } from "./components/conversation-host";
import { DestinationFrame } from "./components/destination-frame";
import { FrontDoor } from "./components/front-door";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FileDiffIcon,
  FolderIcon,
  LayersIcon,
  RennetMark,
  TriangleIcon,
} from "./components/icons";
import { ProjectDetail } from "./components/project-detail";
import { type PublishOutcome, PublishSheet } from "./components/publish-sheet";
import { SettingsScreen } from "./components/settings-screen";
import { CanvasWorkspace } from "./components/workspace";
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

const angles = ["Logic", "Security", "Tests", "Performance", "Maintainability", "Product"];

function activePatchset(review: Review): Patchset {
  const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
  if (!patchset) throw new Error("The active patchset is missing");
  return patchset;
}

export function ReviewWorkspace({
  review,
  selectedPath,
  onSelectPath,
  onSetRead,
  onRegenerate,
}: {
  review: Review;
  selectedPath?: string;
  onSelectPath(path: string): void;
  onSetRead(path: string, read: boolean): void;
  onRegenerate(): void;
}) {
  const patchset = activePatchset(review);
  const selected = patchset.files.find((file) => file.path === selectedPath) ?? patchset.files[0];
  // Read-state is derived: a file is "read" iff it carries a disposition.
  const readPaths = new Set(review.dispositions.map((disposition) => disposition.anchor.path));
  const percentage = patchset.files.length
    ? Math.round((readPaths.size / patchset.files.length) * 100)
    : 100;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          <span className="topbar-mark" aria-hidden="true">
            <RennetMark size={28} />
          </span>
          <div>
            <p className="eyebrow">LOCAL REVIEW</p>
            <h1>{patchset.repository.root.split("/").at(-1)}</h1>
          </div>
        </div>
        <div className="provenance" title={patchset.id}>
          <span>{patchset.repository.baseRef}</span>
          <code>{patchset.repository.baseOid.slice(0, 8)}</code>
          <ArrowRightIcon size={12} className="provenance-arrow" />
          <code>{patchset.repository.headOid.slice(0, 8)}</code>
        </div>
      </header>

      {review.status === "invalid" ? (
        <section className="invalid-banner" role="status">
          <div>
            <strong>Your code changed.</strong>
            <span>Pinned to the previous patchset until you regenerate.</span>
          </div>
          <button type="button" onClick={onRegenerate}>
            Regenerate affected review
          </button>
        </section>
      ) : null}

      <section className="progress-row" aria-label={`${percentage}% of changed files read`}>
        <span>{readPaths.size} read</span>
        <div className="progress-track">
          <span style={{ width: `${percentage}%` }} />
        </div>
        <span>{patchset.files.length} files</span>
      </section>

      <main className="review-grid">
        <aside className="file-panel" aria-label="Changed files">
          <div className="panel-title">Changes</div>
          {patchset.files.length === 0 ? (
            <p className="muted">No changes against {patchset.repository.baseRef}.</p>
          ) : (
            patchset.files.map((file) => {
              const read = readPaths.has(file.path);
              return (
                <button
                  type="button"
                  className={`file-row ${selected?.path === file.path ? "selected" : ""}`}
                  key={file.path}
                  onClick={() => onSelectPath(file.path)}
                >
                  <span className={`status status-${file.status}`}>
                    {file.status[0]?.toUpperCase()}
                  </span>
                  <span className="file-name">{file.path}</span>
                  <span className={`read-dot ${read ? "is-read" : ""}`} aria-hidden="true" />
                </button>
              );
            })
          )}
        </aside>

        <section className="diff-panel">
          <div className="diff-toolbar">
            <div>
              <strong>{selected?.path ?? "No changed file selected"}</strong>
              {selected ? (
                <span>
                  +{selected.additions ?? "–"} −{selected.deletions ?? "–"}
                </span>
              ) : null}
            </div>
            {selected ? (
              <button
                type="button"
                className="secondary"
                onClick={() => onSetRead(selected.path, !readPaths.has(selected.path))}
              >
                {readPaths.has(selected.path) ? "Mark unread" : "Mark read"}
              </button>
            ) : null}
          </div>
          <pre className="diff">{selected?.patch || "There is no diff to display."}</pre>
        </section>

        <aside className="angle-panel" aria-label="Review angles">
          <div className="panel-title">Angles</div>
          <p className="muted">Manual coverage only.</p>
          {angles.map((angle) => (
            <div className="angle-row" key={angle}>
              <span>{angle}</span>
              <span className="angle-state">Not run</span>
            </div>
          ))}
          <div className="snapshot-card">
            <span>PATCHSET</span>
            <code>{patchset.id.slice(0, 12)}</code>
            <small>
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
 * `engine.aiReview` is false only when no model turn ran, so the title always says
 * plainly that the user is NOT looking at an AI review; when the `claude` binary
 * was the missing piece it names that, so the fix is obvious rather than a generic
 * apology. The mechanical outline is real diff STRUCTURE, never AI findings.
 */
function mechanicalFallbackTitle(engine: ReviewEngine): string {
  return engine.claudeAvailable
    ? "The AI review didn't run — showing a basic structural outline."
    : "Couldn't find your Claude CLI — this is a basic structural outline, not an AI review.";
}

function mechanicalFallbackDetail(engine: ReviewEngine): string {
  if (!engine.claudeAvailable && !engine.codexAvailable) {
    return "Install the Claude CLI (or Codex) and retry to get the real AI review of this diff.";
  }
  // A model was installed but no turn ran for this changeset (e.g. the review budget
  // was exhausted before any spend), so what's on screen is structure, not findings.
  return "No model turn ran for this changeset, so these are the diff's structure, not AI findings.";
}

export function RennetApp({ bridge }: { bridge: RennetBridge }) {
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The front door (issue #29) is the app's entry: launching Rennet lands on the
  // Projects list. `atFrontDoor` returns there from an open review; `directEntry`
  // reveals the legacy repo/PR entry so that capability is never orphaned while
  // project-detail (the review's real home) is a later slice.
  const [atFrontDoor, setAtFrontDoor] = useState(false);
  const [directEntry, setDirectEntry] = useState(false);
  // The settings screen (wireframe #15): opened from the front door, closed back
  // to it. `scheme` is the reviewer's chosen appearance, fetched once and applied
  // to the front door's `data-scheme` — so changing it in settings re-themes here.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scheme, setScheme] = useState<AppearanceScheme>("system");
  // Project detail (issue #37): the unified smart list. Clicking a project row opens
  // this surface (local work + every PR in one list); a row there opens the review.
  const [projectDetail, setProjectDetail] = useState<Project | null>(null);
  // The GitHub PR front door (the second v1 source): the ref the user typed
  // (`owner/repo#123` or a PR URL). Opening it picks the local clone, then lands
  // in the same review surface a working-tree capture does.
  const [prRef, setPrRef] = useState("");
  // Retrospective open (read-only): review an already-merged PR to READ the code,
  // with posting structurally off. Drives `review.openPr`'s `retrospective` flag.
  const [prRetrospective, setPrRetrospective] = useState(false);
  // The Canvases view IS the AI review, and it is the default landing surface: a
  // review opens straight onto the real AI review (running it, or the one-tap
  // consent gate under `manual`), never onto canned demo data a first-time user
  // could mistake for real output. The `Files` view (the raw diff) is one tab away.
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
  // model installed) and the UI says so loudly, never passing it off as AI.
  const [engine, setEngine] = useState<ReviewEngine | undefined>(undefined);
  // The Decisions runner's status (issue #137/#160), delivered with the canvas set.
  // Undefined until a live load sets it (or on an older engine that omits it) →
  // the Decisions lens defaults to `ok`. When the runner FAILED, this carries the
  // reason so the lens paints the failed banner instead of "no decisions".
  const [decisionsRun, setDecisionsRun] = useState<DecisionsRunStatus | undefined>(undefined);
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
  const [noiseReview, setNoiseReview] = useState<NoiseReview | undefined>(undefined);
  // The live load returned null (no harness / pipeline error) for THIS review, so
  // there is nothing real to show — the UI offers an honest error + retry rather
  // than silently standing on a demo.
  const [loadFailed, setLoadFailed] = useState(false);
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
  // The EPHEMERAL per-item refinement state (issue #19), keyed by collation-item
  // id. An adopted refinement is durable on the item (`item.refined`); this map
  // holds only the in-flight/failed/no-change states the refine turn produces.
  const [refineStates, setRefineStates] = useState<Record<string, RefineItemState>>({});
  const [destinationMode, setDestinationMode] = useState<DestinationMode>("own-branch");
  // The forming-destination surface (R40): the frame opens the DRAFT (editable
  // glass collation canvas); signing the draft opens the PAPER; the paper signs or
  // goes back to the draft. frame → draft → paper.
  const [destinationView, setDestinationView] = useState<"closed" | "draft" | "paper">("closed");
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

  // The command palette (wireframes screen 16). The view store is LIFTED here so the
  // palette's Lens/Zoom/Appearance commands drive the SAME store the CanvasWorkspace
  // renders from (passed to it as `store` below) — the palette runs the real store
  // methods, never a parallel copy. `paletteOpen` toggles the ⌘K overlay.
  const viewStore = useMemo(() => createViewStore(), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Subscribed so the palette's toggle labels + current lens/zoom read live store state
  // (and so an inert command — the lens already active, a zoom at its clamp — is omitted).
  const canvasAngle = useViewStore(viewStore, (state) => state.angle);
  const canvasScheme = useViewStore(viewStore, (state) => state.scheme);
  const canvasOverlayOn = useViewStore(viewStore, (state) => state.overlayOn);
  const canvasZoomLevel = useViewStore(viewStore, (state) => state.zoom.level);

  // ⌘K (or Ctrl-K) toggles the palette app-wide: the listener is on `window`, so it
  // fires from any surface (front door, project detail, review) regardless of focus.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    bridge
      .invoke("app.bootstrap", {})
      .then(({ review: restored }) => setReview(restored))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [bridge]);

  // The reviewer's appearance scheme (wireframe #15), fetched once so the front
  // door themes to it. Settings updates it live via `onSchemeChange`. Fail-quiet:
  // an unavailable settings surface leaves the builtin `system` default.
  useEffect(() => {
    bridge
      .invoke("settings.get", {})
      .then(({ scheme: loaded }) => setScheme(loaded))
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
    if (!review || review.status === "invalid" || isSnapshotReview) return;
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
  }, [bridge, review, isSnapshotReview]);

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

  // The Flagged lens (issue #138): fetch the automated review layer's findings for
  // the open review over the real command boundary. It carries NO model spend and
  // is independent of the harness-consent gate, so it loads on its own — and its
  // own try/catch means a flagged fetch failure never disturbs the canvas load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the active patchset (#160/P0-2), not the churning review object.
  useEffect(() => {
    if (!reviewId) return;
    let cancelled = false;
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
    };
  }, [reviewId, activePatchsetId, bridge, deepReviewOn]);

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
  // review over the real command boundary. Like the flagged fetch it carries NO
  // model spend and is independent of the harness-consent gate, so it loads on its
  // own — and its own try/catch means a noise fetch failure never disturbs the
  // canvas load or the flagged fetch.
  useEffect(() => {
    if (!reviewId) return;
    let cancelled = false;
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
          setNoiseReview(review as NoiseReview);
        } else {
          setNoiseReview({
            status: "failed",
            reason: "The noise review returned a response Rennet could not read.",
          });
        }
      })
      .catch((reason: unknown) => {
        // A rejected fetch (no handler, transport error, a thrown runner) is a
        // failure to CHECK, not a clean result — surface it honestly as `failed`.
        if (cancelled) return;
        setNoiseReview({
          status: "failed",
          reason: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, bridge]);

  // Live canvases (issue #54): when a real review is open and the Canvases view is
  // shown, fetch the engine-produced canvas set once and render the REAL AI review.
  // Running the harness is Rennet's whole job — it just runs, with no permission
  // gate or consent step. A failure (no harness, pipeline error) returns null and is
  // surfaced as an honest error + retry — never a demo standing in for a review.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce re-triggers the load on retry; review is read via reviewRef, keyed by canvasFetchKey.
  useEffect(() => {
    if (view !== "canvases") return;
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
    let cancelled = false;
    void loadCanvases(bridge, current).then((live) => {
      if (cancelled) return;
      if (!live) {
        // Nothing real came back — surface it honestly rather than standing on a demo.
        // The key is NOT recorded, so the retry affordance (which bumps `reloadNonce`)
        // re-runs this and fetches again — a failed load never poisons the identity.
        setLoadFailed(true);
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
      setLiveLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [view, canvasFetchKey, bridge, reloadNonce]);

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
      setAtFrontDoor(false);
      setDirectEntry(false);
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
      setProjectDetail(null);
      setAtFrontDoor(false);
      setDirectEntry(false);
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
      setProjectDetail(null);
      setAtFrontDoor(false);
      setDirectEntry(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  // Open a pull request into a review (the front door's second source). The user
  // types the ref, then picks the local clone of that repo (reusing the same
  // directory dialog as the working-tree door); the PR's diff is taken locally
  // against its pinned OIDs and lands in the identical review surface.
  async function openPullRequest(): Promise<void> {
    const ref = prRef.trim();
    if (!ref) return;
    setBusy(true);
    setError(undefined);
    try {
      const { path } = await bridge.invoke("repository.choose", {});
      if (!path) return;
      const result = await bridge.invoke("review.openPr", {
        commandId: crypto.randomUUID(),
        ref,
        repoPath: path,
        // Read-only when the reviewer asked to review the PR retrospectively: the
        // created review is flagged and nothing can be posted from it.
        retrospective: prRetrospective,
      });
      setReview(result.review);
      setAtFrontDoor(false);
      setDirectEntry(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
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

  // The always-present destination chrome and the two surfaces it opens (R40):
  // frame → collation draft canvas (editable glass) → paper (sign). dispose ==
  // staged flows through here; signing this shell performs NO Git/GitHub mutation
  // (the #21 pipeline is a later slice) — it clears the draft to demonstrate the
  // full journey ending somewhere. The `.rennet-glass` wrapper carries the glass +
  // paper tokens (scoped alongside `.canvas-app` in tokens.css) WITHOUT the
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
  const publishContext: PublishContext = {
    submission: {
      base: patchset?.repository.baseRef ?? "main",
      head: patchset ? patchset.repository.headOid.slice(0, 7) : "(working tree)",
      draftDefault: true,
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
  // Mode-split the sign so "what you preview is what signs" holds in BOTH modes
  // (issue #109, own-branch half). other-pr previews line-anchored review comments
  // and the wired `publish.review` engine emits exactly those. own-branch previews a
  // PR SUBMISSION whose creation is the separate, GATED #21 act (`publish.egress`) —
  // NO command wires it yet — so an own-branch sign must NOT fall back to
  // `publish.review` (that would emit review comments the human never previewed).
  // Until #21 lands, own-branch sign is an honest handoff no-op: it sends nothing and
  // records the not-yet-wired handoff for the sheet to state plainly.
  function signPaper(): void {
    if (destinationMode === "own-branch") {
      setError(undefined);
      setPublishResult({ kind: "handoff" });
      return;
    }
    void publishReview();
  }
  // A retrospective review is read-only: the entire sign → collate → publish surface
  // is REPLACED by a plain notice, so there is no affordance to post at all. This is
  // the renderer half of the no-post guarantee; MAIN's `publish.review` refusal is the
  // structural half, so even without this the command cannot egress.
  const destinationChrome = review?.retrospective ? (
    <div className="rennet-glass" data-scheme={effectiveScheme}>
      <section className="retrospective-notice" role="note" data-testid="retrospective-notice">
        <p className="eyebrow">RETROSPECTIVE REVIEW</p>
        <p>
          Reading an already-merged pull request. Your dispositions stay local — nothing is posted
          back to GitHub.
        </p>
      </section>
    </div>
  ) : (
    <div className="rennet-glass" data-scheme={effectiveScheme}>
      <DestinationFrame
        draft={draft}
        mode={destinationMode}
        onSelectMode={setDestinationMode}
        onOpenDraft={() => setDestinationView("draft")}
      />
      {destinationView === "draft" ? (
        <CollationDraftCanvas
          draft={draft}
          variant={destinationVariantForMode}
          onChange={setDraft}
          onRefine={(item) => void refineItem(item)}
          onKeepRaw={keepRaw}
          onRefineAll={refineAll}
          refineStates={refineStates}
          onSign={() => {
            // Freezing a fresh paper drops any stale outcome from a prior sign.
            setPublishResult(undefined);
            setDestinationView("paper");
          }}
          onBack={() => setDestinationView("closed")}
        />
      ) : null}
      {destinationView === "paper" ? (
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
          onBack={() => {
            // Editing lives on the draft; a returned-to edit invalidates the outcome.
            setPublishResult(undefined);
            setDestinationView("draft");
          }}
          onSign={() => signPaper()}
          onClose={() => {
            setPublishResult(undefined);
            setDestinationView("closed");
          }}
        />
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
   * council-routed model turn, and round the result back onto the draft. A refined
   * result is ADOPTED only if the note has not been edited meanwhile (a refinement
   * of a stale raw is dropped, never shown over the new text — the #236 law); a
   * no-change / unavailable / failed outcome is surfaced HONESTLY and the raw stays
   * the effective body.
   */
  async function refineItem(item: CollationItem): Promise<void> {
    if (!review || item.raw.trim() === "") return;
    const refinedFrom = item.raw;
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
      });
      if (result.status === "refined") {
        setDraft((current) => {
          const target = current.find((entry) => entry.id === item.id);
          // The note was edited or withdrawn while the turn ran — drop the stale
          // refinement rather than post a clean version of text that no longer exists.
          if (!target || target.raw !== refinedFrom) return current;
          return setRefined(current, item.id, result.refined);
        });
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

  /** Refine every refinable, not-yet-refined, not-in-flight item in one act. */
  function refineAll(): void {
    for (const item of draft) {
      if (
        item.raw.trim() !== "" &&
        item.refined === undefined &&
        refineStates[item.id]?.status !== "refining"
      ) {
        void refineItem(item);
      }
    }
  }

  // Which top-level surface is showing — mirrors the branch order of the returns
  // below, so the palette offers exactly the commands live for the current screen.
  const screen: Screen | null =
    review === undefined
      ? null
      : projectDetail
        ? "projectDetail"
        : atFrontDoor || !review
          ? directEntry
            ? "directEntry"
            : "frontDoor"
          : "workspace";
  // The lens/zoom/scheme commands act on the live store, so they are only offered
  // while the Canvases view is actually showing a loaded review.
  const canvasReady = view === "canvases" && liveLoaded && canvases !== null;
  const commandContext: CommandContext | null = screen
    ? {
        screen,
        canvasReady,
        view,
        deepReviewOn,
        overlayOn: canvasOverlayOn,
        scheme: canvasScheme,
        angle: canvasAngle,
        zoomLevel: canvasZoomLevel,
        backToProjects: () => setAtFrontDoor(true),
        backToProjectList: () => setProjectDetail(null),
        showFiles: () => setView("review"),
        showCanvases: () => setView("canvases"),
        reviewDirectly: () => {
          setDirectEntry(true);
          setAtFrontDoor(true);
        },
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
  const palette = (
    <CommandPalette
      open={paletteOpen}
      commands={commandContext ? buildCommands(commandContext) : []}
      onClose={() => setPaletteOpen(false)}
    />
  );

  if (review === undefined) return <div className="loading">Restoring local review…</div>;

  // Project detail (issue #37): clicking a project row opens its unified smart list —
  // local work + every PR in one surface. It takes precedence over the front door and
  // the review workspace; opening a row from here captures a review (and clears this).
  if (projectDetail) {
    return (
      <>
        {error ? <div className="error-toast">{error}</div> : null}
        {busy ? <div className="busy-bar" /> : null}
        <ProjectDetail
          bridge={bridge}
          project={projectDetail}
          scheme={effectiveScheme}
          onOpenRow={(row) => void openRow(projectDetail, row)}
          onBack={() => setProjectDetail(null)}
        />
        {palette}
      </>
    );
  }

  // The settings screen (wireframe #15): opened from the front door's affordance,
  // closed back to it. Takes precedence over the front door so it is a full screen,
  // not an overlay; the chosen scheme flows back to `data-scheme` on close.
  if (settingsOpen) {
    return (
      <>
        {error ? <div className="error-toast">{error}</div> : null}
        <SettingsScreen
          bridge={bridge}
          scheme={effectiveScheme}
          onBack={() => setSettingsOpen(false)}
          onSchemeChange={setScheme}
        />
      </>
    );
  }

  // The front door is the app's entry: shown on first run (no restored review) and
  // whenever the user steps back to Projects from an open review. The legacy repo/PR
  // entry is one terse disclosure away so no existing capability is orphaned.
  if (atFrontDoor || !review) {
    if (!directEntry) {
      return (
        <>
          {error ? <div className="error-toast">{error}</div> : null}
          {busy ? <div className="busy-bar" /> : null}
          <FrontDoor
            bridge={bridge}
            onOpenProject={(project) => setProjectDetail(project)}
            onOpenSettings={() => setSettingsOpen(true)}
            scheme={effectiveScheme}
          />
          <button
            type="button"
            className="front-door-direct"
            onClick={() => {
              setDirectEntry(true);
              setAtFrontDoor(true);
            }}
          >
            Review directly
          </button>
          {palette}
        </>
      );
    }
    return (
      <>
        {palette}
        <main className="empty-state">
          <button type="button" className="entry-back" onClick={() => setDirectEntry(false)}>
            <ArrowLeftIcon size={13} />
            Projects
          </button>
          <div className="mark" aria-hidden="true">
            <RennetMark size={34} />
          </div>
          <p className="eyebrow">RENNET</p>
          <h1>Start a review.</h1>
          <p>Capture local git changes into one patchset.</p>
          <button type="button" disabled={busy} onClick={chooseRepository}>
            <FolderIcon size={15} />
            {busy ? "Working…" : "Choose a repository"}
          </button>

          <div className="entry-divider" aria-hidden="true">
            <span>or a pull request</span>
          </div>

          <form
            className="pr-door"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault();
              void openPullRequest();
            }}
          >
            <input
              type="text"
              className="pr-input"
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
              className="secondary"
              disabled={busy || prRef.trim().length === 0}
            >
              {busy ? "Opening…" : "Open pull request"}
            </button>
            <label className="pr-retrospective">
              <input
                type="checkbox"
                checked={prRetrospective}
                onChange={(inputEvent) => setPrRetrospective(inputEvent.target.checked)}
                disabled={busy}
              />
              <span>Retrospective review — read an already-merged PR. Nothing is posted back.</span>
            </label>
          </form>
          <p className="pr-hint">Pick the local clone next.</p>

          {error ? <p className="error">{error}</p> : null}
        </main>
      </>
    );
  }

  return (
    <>
      {error ? <div className="error-toast">{error}</div> : null}
      {busy ? <div className="busy-bar" /> : null}
      <button
        type="button"
        className="workspace-projects"
        onClick={() => setAtFrontDoor(true)}
        aria-label="Back to projects"
      >
        <ArrowLeftIcon size={13} />
        Projects
      </button>
      <div className="view-toggle" role="tablist" aria-label="Workspace view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "review"}
          className={view === "review" ? "is-active" : ""}
          onClick={() => setView("review")}
        >
          <FileDiffIcon size={13} />
          Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "canvases"}
          className={view === "canvases" ? "is-active" : ""}
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
              <div className="engine-fallback" role="alert">
                <TriangleIcon size={18} className="engine-fallback-icon" />
                <div className="engine-fallback-copy">
                  <strong>{mechanicalFallbackTitle(engine)}</strong>
                  <span>{mechanicalFallbackDetail(engine)}</span>
                </div>
                <button type="button" className="secondary" onClick={retryLiveLoad}>
                  Retry the AI review
                </button>
              </div>
            ) : null}
            <CanvasWorkspace
              store={viewStore}
              canvases={canvases}
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
              noiseReview={noiseReview}
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
                  ? (name) => bridge.invoke("review.symbolLookup", { reviewId: review.id, name })
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
            />
            {/* Ask the AI about this review (issue #139): the live conversational
                affordance. Present once a real review has loaded, so a question is
                always ABOUT the open review. Asking a model is Rennet's whole job —
                the ask just runs, with no permission step. */}
            {review ? <AskPanel bridge={bridge} reviewId={review.id} /> : null}
            {/* The inline conversation (issue #36), LIVE: open a private thread on any
                changed file and converse with the orchestrator. Each turn runs the
                real `review.ask` boundary and the orchestrator's OWN answer populates
                the thread — no fixture. Keyed by review id so a new review starts a
                fresh conversation. Per-diff-LINE anchoring inside the diff renderer is
                the remaining wireframe ambition; the conversation itself is live and
                multi-turn-contextual now, anchored to the review's real files. */}
            {review && patchset ? (
              <ConversationHost
                key={review.id}
                bridge={bridge}
                reviewId={review.id}
                anchors={patchset.files.map(
                  (file): ConversationAnchor => ({
                    kind: "chunk",
                    label: file.path,
                    key: file.path,
                  }),
                )}
              />
            ) : null}
          </>
        ) : loadFailed ? (
          <section className="canvas-primer" role="alert">
            <p className="eyebrow">AI REVIEW</p>
            <h2>The review failed.</h2>
            <p>The engine returned nothing.</p>
            <button type="button" onClick={retryLiveLoad}>
              Try again
            </button>
          </section>
        ) : (
          <section className="canvas-primer" role="status">
            <p className="eyebrow">AI REVIEW</p>
            <h2>Running the review…</h2>
            <p>Reading the diff and drafting review angles.</p>
          </section>
        )
      ) : (
        <ReviewWorkspace
          review={review}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          onSetRead={(path, read) => void setFileRead(path, read)}
          onRegenerate={() => void regenerate()}
        />
      )}
      {/* The destination is always-present chrome: the north is visible in both the
          Files and Canvases views, present from review-open even when empty. */}
      {destinationChrome}
      {palette}
    </>
  );
}
