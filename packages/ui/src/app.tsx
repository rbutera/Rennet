import {
  type PermissionMode,
  type RennetBridge,
  requiresConsent,
  resolvePermissionMode,
} from "@rennet/protocol";
import type {
  CanvasAngle,
  ElementDiffs,
  NarrativeProgressEvent,
  Patchset,
  Review,
  ReviewNarration,
} from "@rennet/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { type CollationDraft, ingestWrites, withdrawPath } from "./canvas/collation";
import { type DestinationMode, destinationVariant, type PublishLedger } from "./canvas/destination";
import { demoCanvases, demoDiff, demoNarration } from "./canvas/fixtures";
import { type CanvasSet, loadCanvases } from "./canvas/load";
import { type DispositionWrite, withoutProposal } from "./canvas/logic";
import { type PublishContext, publishTarget, publishTargetPayload } from "./canvas/publish";
import { CollationDraftCanvas } from "./components/collation-draft-canvas";
import { DestinationFrame } from "./components/destination-frame";
import { HarnessConsent } from "./components/harness-consent";
import { NarrativeFeed } from "./components/narrative-feed";
import { PublishSheet } from "./components/publish-sheet";
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

/** Merge R35-conflated live updates with a returned resumable snapshot by key. */
function mergeNarrativeProgress(
  current: readonly NarrativeProgressEvent[],
  incoming: readonly NarrativeProgressEvent[],
): NarrativeProgressEvent[] {
  const byKey = new Map(current.map((event) => [event.key, event]));
  for (const event of incoming) byKey.set(event.key, event);
  return [...byKey.values()].sort((left, right) => left.seq - right.seq);
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
        <div>
          <p className="eyebrow">LOCAL REVIEW</p>
          <h1>{patchset.repository.root.split("/").at(-1)}</h1>
        </div>
        <div className="provenance" title={patchset.id}>
          <span>{patchset.repository.baseRef}</span>
          <code>{patchset.repository.baseOid.slice(0, 8)}</code>
          <span>→</span>
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

export function RennetApp({ bridge }: { bridge: RennetBridge }) {
  const [review, setReview] = useState<Review | null | undefined>(undefined);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The canvas surface (issue #11) is an additive view. It is fixtures-backed
  // until the engine's canvas.snapshot feed lands; approving fans out to local
  // optimistic L2 so the demo is real and clickable. The review-capture flow is
  // the untouched real end-to-end path.
  const [view, setView] = useState<"review" | "canvases">("review");
  const [canvases, setCanvases] = useState<CanvasSet>(() => demoCanvases());
  // The real per-element diff map (issue #60) and whether the on-screen canvases
  // are the real set. While `liveLoaded` is false the fixtures demo is up and the
  // zoom surface uses `demoDiff`; once a real set loads, zoom reads real code.
  const [elementDiffs, setElementDiffs] = useState<ElementDiffs>({});
  // The roll-up narration (issue #70): the zoom ladder's own voice, delivered
  // alongside the canvas set. The demo seeds narrated accounts; a live load sets
  // whatever the engine produced (undefined → the honest pending state).
  const [narration, setNarration] = useState<ReviewNarration | undefined>(() => demoNarration());
  // Parent-owned, review-keyed progress makes the long-running stage resumable:
  // switching back to Files does not discard what the local pipeline already
  // made legible, and re-opening Canvases reads the same summary.
  const [narrativeProgress, setNarrativeProgress] = useState<NarrativeProgressEvent[]>([]);
  const reviewId = review?.id;
  const [liveLoaded, setLiveLoaded] = useState(false);
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

  useEffect(() => {
    if (!reviewId) {
      setNarrativeProgress([]);
      return;
    }
    setNarrativeProgress([]);
    return bridge.subscribeNarrativeProgress?.(reviewId, (event) => {
      setNarrativeProgress((current) => mergeNarrativeProgress(current, [event]));
    });
  }, [bridge, reviewId]);

  useEffect(() => {
    if (!review || review.status === "invalid") return;
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
  }, [bridge, review]);

  useEffect(() => {
    if (!patchset?.files.some((file) => file.path === selectedPath)) {
      setSelectedPath(patchset?.files[0]?.path);
    }
  }, [patchset, selectedPath]);

  // The harness run for opening Canvases is a gated action (issue #58), governed
  // by the permission mode (issue #103). In a mode that ASKS (manual), the
  // harness does not run until the user consents for THIS review; `auto`/`bypass`
  // proceed with no prompt. The floor/demo canvases are already on screen either
  // way — only the model-enrichment turns gate here.
  const awaitingHarnessConsent =
    view === "canvases" &&
    !!review &&
    requiresConsent(effectiveMode, "harness.run") &&
    harnessAuthorization?.reviewId !== review.id;

  // Live canvases (issue #54): when a real review is open, the Canvases view is
  // shown, and the harness run is permitted (auto/bypass, or the user has
  // consented under manual), fetch the engine-produced canvas set once and render
  // it in place of the fixtures. A failure (no harness, pipeline error) returns
  // null and leaves the clickable demo untouched, so the demo never regresses.
  useEffect(() => {
    if (view !== "canvases" || !review) return;
    if (fetchedForReview.current === review.id) return;
    if (awaitingHarnessConsent) return; // #58 gate: await consent before any harness turn
    fetchedForReview.current = review.id;
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
      if (cancelled || !live) return;
      setCanvases(live.canvases);
      setElementDiffs(live.elementDiffs);
      setNarration(live.narration);
      if (live.progress) {
        setNarrativeProgress((current) => mergeNarrativeProgress(current, live.progress ?? []));
      }
      setLiveLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [view, review, bridge, awaitingHarnessConsent, effectiveMode, harnessAuthorization]);

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
          onSign={() => setDestinationView("paper")}
          onBack={() => setDestinationView("closed")}
        />
      ) : null}
      {destinationView === "paper" ? (
        <PublishSheet
          target={publishTargetForMode}
          payload={publishTargetPayload(publishTargetForMode)}
          variant={destinationVariantForMode}
          ledger={publishLedger}
          onBack={() => setDestinationView("draft")}
          onSign={() => {
            setDraft([]);
            setDestinationView("closed");
          }}
          onClose={() => setDestinationView("closed")}
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
        <div className="mark">R</div>
        <p className="eyebrow">RENNET</p>
        <h1>Review the code you actually have.</h1>
        <p>
          Capture committed branch work, staged changes, unstaged edits, and untracked files into
          one immutable local patchset.
        </p>
        <button type="button" disabled={busy} onClick={chooseRepository}>
          {busy ? "Capturing…" : "Choose a repository"}
        </button>
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
          Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "canvases"}
          className={view === "canvases" ? "is-active" : ""}
          onClick={() => setView("canvases")}
        >
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
        liveLoaded ? (
          <CanvasWorkspace
            canvases={canvases}
            bridge={bridge}
            narration={narration}
            narrativeProgress={narrativeProgress}
            onDispositions={(writes) => {
              setCanvases((current) => applyWrites(current, writes));
              // dispose == staged: authoring a disposition collates it into the draft
              // in the same act (upsert-by-path, one act ingests all its fan-out writes).
              setDraft((current) => ingestWrites(current, writes));
            }}
            onAdjudicate={(adjudication) =>
              setCanvases((current) => resolveProposal(current, adjudication.proposalId))
            }
            // Real code on the real path (issue #60): once a live canvas set has
            // loaded, zoom reads the real per-element diff (a doc-anchored element
            // has no entry → the zoom surface renders nothing, not a fixture). While
            // the fixtures demo is up, the demo `demoDiff` is unchanged.
            diffFor={(elementKey) =>
              liveLoaded ? elementDiffs[elementKey] : { path: elementKey, diff: demoDiff(400) }
            }
          />
        ) : (
          <main className="narrative-stage canvas-app" data-scheme="dark">
            <NarrativeFeed events={narrativeProgress} />
          </main>
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
