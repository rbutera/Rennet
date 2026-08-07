import type { RennetBridge } from "@rennet/protocol";
import type { CanvasAngle, ElementDiffs, Patchset, Review, ReviewNarration } from "@rennet/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { addToBatch, type DispositionBatch, withdrawDraft } from "./canvas/authoring";
import { type DestinationMode, destinationVariant, draftsFromWrites } from "./canvas/destination";
import { demoCanvases, demoDiff, demoNarration } from "./canvas/fixtures";
import { type CanvasSet, loadCanvases } from "./canvas/load";
import { type DispositionWrite, withoutProposal } from "./canvas/logic";
import { DestinationFrame } from "./components/destination-frame";
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
  const [liveLoaded, setLiveLoaded] = useState(false);
  const fetchedForReview = useRef<string | null>(null);
  // The DESTINATION (issue #64): the staged set is the north the review builds
  // toward. dispose == staged (a disposition stages in the same act it is made);
  // withdraw == unstage. The mode frames the same staged data as the own-branch
  // handoff bundle or the review to post on someone else's PR. `own-branch` is the
  // honest default for a local capture; the real mode arrives with the #20/#21
  // GitHub source. The publish sheet (#22 shell) is opened from the frame.
  const [staged, setStaged] = useState<DispositionBatch>([]);
  const [destinationMode, setDestinationMode] = useState<DestinationMode>("own-branch");
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    bridge
      .invoke("app.bootstrap", {})
      .then(({ review: restored }) => setReview(restored))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [bridge]);

  const patchset = useMemo(() => (review ? activePatchset(review) : undefined), [review]);

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

  // Live canvases (issue #54): when a real review is open and the Canvases view
  // is shown, fetch the engine-produced canvas set once and render it in place of
  // the fixtures. A failure (no harness, pipeline error) returns null and leaves
  // the clickable demo untouched, so the demo never regresses.
  useEffect(() => {
    if (view !== "canvases" || !review) return;
    if (fetchedForReview.current === review.id) return;
    fetchedForReview.current = review.id;
    let cancelled = false;
    void loadCanvases(bridge, review).then((live) => {
      if (cancelled || !live) return;
      setCanvases(live.canvases);
      setElementDiffs(live.elementDiffs);
      setNarration(live.narration);
      setLiveLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [view, review, bridge]);

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
    // dispose == staged / withdraw == unstage: the same act stages (or unstages) it
    // toward the destination, so the north fills as the review is worked.
    setStaged((current) =>
      read
        ? addToBatch(current, draftsFromWrites([{ path, type: "comment", body: "" }]))
        : withdrawDraft(current, path),
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

  // The always-present destination chrome + the publish sheet it opens. dispose ==
  // staged flows through here; signing this shell performs NO Git/GitHub mutation
  // (the #21 pipeline is a later slice) — it clears the staged paper to demonstrate
  // the full journey ending somewhere.
  const destinationChrome = (
    <>
      <DestinationFrame
        batch={staged}
        mode={destinationMode}
        onSelectMode={setDestinationMode}
        onOpenPublish={() => setPublishOpen(true)}
      />
      {publishOpen ? (
        <PublishSheet
          batch={staged}
          variant={destinationVariant(destinationMode)}
          onWithdraw={(path) => setStaged((current) => withdrawDraft(current, path))}
          onSign={() => {
            setStaged([]);
            setPublishOpen(false);
          }}
          onClose={() => setPublishOpen(false)}
        />
      ) : null}
    </>
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
      {view === "canvases" ? (
        <CanvasWorkspace
          canvases={canvases}
          bridge={bridge}
          narration={narration}
          onDispositions={(writes) => {
            setCanvases((current) => applyWrites(current, writes));
            // dispose == staged: authoring a disposition stages it toward the
            // destination in the same act (upsert-by-path, one act stages all its
            // fan-out writes).
            setStaged((current) => addToBatch(current, draftsFromWrites(writes)));
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
