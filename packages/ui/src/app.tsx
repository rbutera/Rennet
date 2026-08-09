import {
  type PermissionMode,
  type RennetBridge,
  requiresConsent,
  resolvePermissionMode,
} from "@rennet/protocol";
import type {
  CanvasAngle,
  ElementDiffs,
  Patchset,
  Review,
  ReviewEngine,
  ReviewNarration,
} from "@rennet/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { type CollationDraft, ingestWrites, withdrawPath } from "./canvas/collation";
import { type DestinationMode, destinationVariant, type PublishLedger } from "./canvas/destination";
import { type CanvasSet, loadCanvases } from "./canvas/load";
import { type DispositionWrite, withoutProposal } from "./canvas/logic";
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
import { CollationDraftCanvas } from "./components/collation-draft-canvas";
import { DestinationFrame } from "./components/destination-frame";
import {
  ArrowRightIcon,
  FileDiffIcon,
  FolderIcon,
  LayersIcon,
  RennetMark,
  TriangleIcon,
} from "./components/icons";
import { HarnessConsent } from "./components/harness-consent";
import { type PublishReviewResult, PublishSheet } from "./components/publish-sheet";
import { CanvasWorkspace } from "./components/workspace";

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
            <span>The review stays pinned to the previous patchset until you regenerate it.</span>
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
          <p className="muted">Manual coverage for this first local slice.</p>
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
  // The GitHub PR front door (the second v1 source): the ref the user typed
  // (`owner/repo#123` or a PR URL). Opening it picks the local clone, then lands
  // in the same review surface a working-tree capture does.
  const [prRef, setPrRef] = useState("");
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
  const [liveLoaded, setLiveLoaded] = useState(false);
  // The live load returned null (no harness / pipeline error) for THIS review, so
  // there is nothing real to show — the UI offers an honest error + retry rather
  // than silently standing on a demo.
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped by the retry affordance to re-run the live load for the same review
  // (e.g. after the user installs their Claude CLI and asks for the real review).
  const [reloadNonce, setReloadNonce] = useState(0);
  const fetchedForReview = useRef<string | null>(null);
  // Permission mode (issue #103). The persisted workspace default governs the
  // gated harness run (#58); `undefined` until bootstrap resolves it, which
  // `resolvePermissionMode` treats as the safe `manual` default. `harnessAuthorization`
  // holds the single-use, review-bound token MAIN minted when the user approved
  // THIS review's harness run (bead workspace-fyvxb) — the renderer relays it, it
  // never asserts consent itself. It is a per-run allow that does NOT change the
  // persisted workspace mode.
  const [workspaceMode, setWorkspaceMode] = useState<PermissionMode | undefined>(undefined);
  const [harnessAuthorization, setHarnessAuthorization] = useState<{
    reviewId: string;
    token: string;
  } | null>(null);
  const effectiveMode = resolvePermissionMode({ workspace: workspaceMode });
  // The DESTINATION (issue #64): the staged set is the north the review builds
  // toward. dispose == staged (a disposition stages in the same act it is made);
  // withdraw == unstage. The mode frames the same staged data as the own-branch
  // handoff bundle or the review to post on someone else's PR. `own-branch` is the
  // honest default for a local capture; the real mode arrives with the #20/#21
  // GitHub source. The publish sheet (#22 shell) is opened from the frame.
  const [draft, setDraft] = useState<CollationDraft>([]);
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
  const [publishResult, setPublishResult] = useState<PublishReviewResult | undefined>(undefined);

  useEffect(() => {
    bridge
      .invoke("app.bootstrap", {})
      .then(({ review: restored }) => setReview(restored))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [bridge]);

  // Load the persisted workspace permission mode (issue #103). A failure (older
  // bridge, missing command) leaves it undefined, which resolves to the safe
  // `manual` default — the harness stays gated rather than silently auto-running.
  useEffect(() => {
    bridge
      .invoke("settings.permissionMode", {})
      .then(({ mode }) => setWorkspaceMode(mode))
      .catch(() => undefined);
  }, [bridge]);

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

  // The harness run for opening Canvases is a gated action (issue #58), governed
  // by the permission mode (issue #103). In a mode that ASKS (manual), the
  // harness does not run until the user consents for THIS review; `auto`/`bypass`
  // proceed with no prompt. This is the one-tap gate to the REAL AI review — the
  // Canvases view shows the running/consent/failed states, never demo canvases.
  const awaitingHarnessConsent =
    view === "canvases" &&
    !!review &&
    requiresConsent(effectiveMode, "harness.run") &&
    harnessAuthorization?.reviewId !== review.id;

  // A new review starts with NO live canvases: clear any prior review's set (and
  // its load-once guard) so the Canvases view never shows a stale AI review, or a
  // stale fallback banner, while the new review's real review loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on review identity only.
  useEffect(() => {
    setCanvases(null);
    setElementDiffs({});
    setNarration(undefined);
    setEngine(undefined);
    setLiveLoaded(false);
    setLoadFailed(false);
    fetchedForReview.current = null;
  }, [reviewId]);

  // Live canvases (issue #54): when a real review is open, the Canvases view is
  // shown, and the harness run is permitted (auto/bypass, or the user has
  // consented under manual), fetch the engine-produced canvas set once and render
  // the REAL AI review. A failure (no harness, pipeline error) returns null and is
  // surfaced as an honest error + retry — never a demo standing in for a review.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce re-triggers the load on retry.
  useEffect(() => {
    if (view !== "canvases" || !review) return;
    if (fetchedForReview.current === review.id) return;
    if (awaitingHarnessConsent) return; // #58 gate: await consent before any harness turn
    fetchedForReview.current = review.id;
    setLoadFailed(false);
    let cancelled = false;
    // The single-use harness-run authorization relayed to the main gate (bead
    // workspace-fyvxb): under a mode that ASKS, pass the token MAIN minted for
    // THIS review (the `awaitingHarnessConsent` guard above guarantees it is
    // present here); under auto/bypass no token is needed, so pass `null` and
    // main requires none. Main verifies + consumes the token — the renderer no
    // longer asserts a boolean it could forge or replay.
    const authorization =
      requiresConsent(effectiveMode, "harness.run") && harnessAuthorization?.reviewId === review.id
        ? harnessAuthorization.token
        : null;
    void loadCanvases(bridge, review, authorization).then((live) => {
      if (cancelled) return;
      if (!live) {
        // Nothing real came back — surface it honestly rather than standing on a demo.
        setLoadFailed(true);
        return;
      }
      setCanvases(live.canvases);
      setElementDiffs(live.elementDiffs);
      setNarration(live.narration);
      setEngine(live.engine);
      setLiveLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    view,
    review,
    bridge,
    awaitingHarnessConsent,
    effectiveMode,
    harnessAuthorization,
    reloadNonce,
  ]);

  // Retry the live load for the current review (the honest-failure and mechanical-
  // fallback surfaces both offer this). Clearing the load-once guard + bumping the
  // nonce re-runs the effect above; e.g. the user installs their Claude CLI, then
  // asks for the real AI review without reopening the app.
  function retryLiveLoad(): void {
    fetchedForReview.current = null;
    setLoadFailed(false);
    setLiveLoaded(false);
    setReloadNonce((nonce) => nonce + 1);
  }

  // Opt the workspace default up to `auto` (persisted). Under `auto` the mode no
  // longer asks, so no per-run token is needed — the canvases effect fires with
  // `authorization: null` and main requires none. A persistence failure still
  // flips the local mode so the current run proceeds and the click is never inert.
  function alwaysRunAutomatically(): void {
    if (!review) return;
    setWorkspaceMode("auto");
    bridge
      .invoke("settings.setPermissionMode", { mode: "auto" })
      .then(({ mode }) => setWorkspaceMode(mode))
      .catch(() => undefined);
  }

  // Approve THIS review's harness run (bead workspace-fyvxb). The renderer only
  // REQUESTS approval: MAIN mints the single-use, review-bound token and returns
  // it here, and the canvases effect then relays that token on `review.canvases`.
  // The renderer never fabricates or asserts consent — it holds a token main
  // issued, which main consumes once.
  async function consentThisRun(): Promise<void> {
    if (!review) return;
    try {
      const { authorization } = await bridge.invoke("harness.requestConsent", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
      });
      setHarnessAuthorization({ reviewId: review.id, token: authorization });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
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
      });
      setReview(result.review);
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
  const publishTargetForMode = publishTarget(destinationMode, draft, publishContext);
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
  // Sign the paper by running the real publish engine (bead wire-sign-publish).
  // Builds the review-comments outbound form from the collated draft, then invokes
  // `publish.review` in DRY-RUN (the default): MAIN constructs the exact GitHub
  // request, re-derives the canonical payload and fails CLOSED on any mismatch
  // ("what you see is what leaves", R33), and posts NOTHING. The verdict is derived
  // from the dispositions and passed explicitly, so what the paper SHOWS is exactly
  // what the engine would post. The outcome is surfaced on the paper; the real,
  // consented, non-dry-run send is a later, deliberately gated act (#21).
  async function publishReview(): Promise<void> {
    if (!review || !patchset) return;
    const comments = reviewComments(draft, publishContext.anchors);
    if (comments.length === 0) return; // the paper's sign is already disabled when empty
    const payload = reviewCommentsPayload(comments);
    const verdict = deriveReviewEvent(comments);
    const target = previewPublishTarget(patchset.repository);
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await bridge.invoke("publish.review", {
        commandId: crypto.randomUUID(),
        reviewId: review.id,
        target,
        // The canonical review-comment shape MAIN validates against `payload` (the
        // ui `ReviewComment` carries a `refined` flag the command schema does not —
        // drop it, and omit an absent line so `line ?? null` matches on both sides).
        comments: comments.map((comment) => ({
          path: comment.path,
          ...(comment.line !== undefined ? { line: comment.line } : {}),
          side: comment.side,
          type: comment.type,
          body: comment.body,
        })),
        payload,
        verdict,
        // Explicit true (the schema default). Real posting must opt in with false.
        dryRun: true,
      });
      setPublishResult({
        dryRun: outcome.dryRun,
        verdict,
        count: comments.length,
        targetLabel: previewTargetLabel(target),
        endpoint: outcome.request.endpoint,
        method: outcome.request.method,
        marker: outcome.marker,
        ledgerCount: outcome.ledger.length,
        preview: true,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const destinationChrome = (
    <div className="rennet-glass" data-scheme="dark">
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
          onBack={() => {
            // Editing lives on the draft; a returned-to edit invalidates the outcome.
            setPublishResult(undefined);
            setDestinationView("draft");
          }}
          onSign={() => void publishReview()}
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

  if (review === undefined) return <div className="loading">Restoring local review…</div>;

  if (!review) {
    return (
      <main className="empty-state">
        <div className="mark" aria-hidden="true">
          <RennetMark size={34} />
        </div>
        <p className="eyebrow">RENNET</p>
        <h1>Review the code you actually have.</h1>
        <p>
          Capture committed branch work, staged changes, unstaged edits, and untracked files into
          one immutable local patchset.
        </p>
        <button type="button" disabled={busy} onClick={chooseRepository}>
          <FolderIcon size={15} />
          {busy ? "Working…" : "Choose a repository"}
        </button>

        <div className="entry-divider" aria-hidden="true">
          <span>or review a pull request</span>
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
            placeholder="owner/repo#123  or  a GitHub PR URL"
            aria-label="Pull request reference"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={busy}
          />
          <button type="submit" className="secondary" disabled={busy || prRef.trim().length === 0}>
            {busy ? "Opening…" : "Open pull request"}
          </button>
        </form>
        <p className="pr-hint">You will pick the local clone of the repository.</p>

        {error ? <p className="error">{error}</p> : null}
      </main>
    );
  }

  return (
    <>
      {error ? <div className="error-toast">{error}</div> : null}
      {busy ? <div className="busy-bar" /> : null}
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
      {view === "canvases" && awaitingHarnessConsent && review ? (
        <HarnessConsent
          repositoryRoot={review.repositoryRoot}
          mode={effectiveMode}
          onConsent={() => void consentThisRun()}
          onAlwaysAuto={alwaysRunAutomatically}
        />
      ) : null}
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
              canvases={canvases}
              bridge={bridge}
              narration={narration}
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
            />
          </>
        ) : awaitingHarnessConsent ? (
          // The one-tap consent gate (the fixed overlay above) is the primary CTA;
          // behind it a calm primer stands in — never demo canvases.
          <section className="canvas-primer" aria-hidden="true">
            <p className="eyebrow">AI REVIEW</p>
            <h2>Your AI code review is one tap away.</h2>
            <p>Grant permission above and Rennet runs the review over your captured diff.</p>
          </section>
        ) : loadFailed ? (
          <section className="canvas-primer" role="alert">
            <p className="eyebrow">AI REVIEW</p>
            <h2>The AI review couldn't be produced.</h2>
            <p>The review engine returned nothing for this changeset.</p>
            <button type="button" onClick={retryLiveLoad}>
              Try again
            </button>
          </section>
        ) : (
          <section className="canvas-primer" role="status">
            <p className="eyebrow">AI REVIEW</p>
            <h2>Running your AI review…</h2>
            <p>Reading the diff and drafting the review angles over your own subscription.</p>
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
    </>
  );
}
