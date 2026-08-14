import { realpathSync } from "node:fs";
import {
  type CanvasOpsBackend,
  type ContextAssembly,
  escapePath,
  type HarnessPort,
  type ReviewBackendState,
  reviewBackendCore,
} from "@rennet/core";
import type { ContextManifest, Patchset, Review } from "@rennet/types";
import { contextAskBackend } from "./context-ask-backend";
import { assembleContextForComposition } from "./context-manifest";
import { ContextManifestStore } from "./context-manifest-store";
import { execaGit, type GitExec } from "./git-range-diff";
import { knowledgeBackend } from "./knowledge-backend";
import { enrichKnowledgeForRepo } from "./knowledge-enrichment";
import { KnowledgeStore } from "./knowledge-store";
import { resolveMapSource } from "./map-travel";
import { NestedProjectContext } from "./nested-project-context";
import { noveltyBackend, type ResolvedNoveltyContext } from "./novelty-ledger-backend";
import { NoveltyLedgerReader } from "./novelty-ledger-reader";
import type { NoveltyLifecycleRegistry } from "./novelty-lifecycle-registry";
import { projectContextBackend, type ResolvedRepoContext } from "./project-context-backend";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import { projectSnapshotPinResolver } from "./project-snapshot-pin";
import { type ResolvedBase, resolveBaseRef } from "./project-snapshot-source";
import type { ProjectSnapshotStore } from "./project-snapshot-store";
import { RepoCompositionStore } from "./repo-composition-store";
import { SnapshotOverlayGenerator, SnapshotOverlayReader } from "./snapshot-overlay-generator";
import { SnapshotOverlayStore } from "./snapshot-overlay-store";

// ─────────────────────────────────────────────────────────────────────────────
// The production `CanvasOpsBackend` composition root (issue #13 — live end-to-end
// review). This is the ONE place the store is touched, so `core` stays node-free:
//
//   reviewBackendCore(state)                    ← pure canvas/diff/run accessors
//     spread with
//   projectContextBackend(reader, resolveCtx)   ← store-backed context.map/file
//   noveltyBackend(noveltyReader, resolveNov)   ← store-backed context.novelty
//     ⇒ one CanvasOpsBackend the whole canvasOps@2 surface reads through.
//
// On review open we generate the deterministic ProjectSnapshot at the review's
// PINNED base OID and advance the store (after integrity validation, #164), so
// `context.map`/`context.file`/`context.novelty` serve REAL snapshot-derived data
// rather than a uniform `absent` refusal. Generation is model-free, fail-closed,
// and size-gated: on failure (or an oversize repo) the readers still gate every
// read to a typed `absent`/`stale`/`corrupt`, and NOTHING is fabricated. Crucially
// the PRODUCER path (the built canvases/lenses) does not depend on the snapshot, so
// a big/slow repo degrades to "repo map refuses, lenses still render" — never a
// hang and never a fake.
// ─────────────────────────────────────────────────────────────────────────────

/** The active captured patchset of a review (the one the canvases were built over). */
export function activePatchset(review: Review): Patchset {
  const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
  if (!patchset) throw new Error("The active patchset is missing");
  return patchset;
}

/** The RepoRecord: a review's store key plus the base OID its snapshot must match. */
export interface RepoRecord {
  /** The per-project store key: `escapePath(realpath(git-top-level))` (design §1.1). */
  readonly repoKey: string;
  /** The active patchset's pinned base OID (the snapshot freshness pin, R30). */
  readonly baseOid: string;
}

/**
 * The ProjectSnapshot store key: `escapePath(realpath(git-top-level))` (#141 /
 * R55, design §1.1). The captured patchset carries the absolute top-level `root`,
 * and this is the SAME value `resolveBaseRef` (`project-snapshot-source`) derives
 * for the generator, so the generator and the reader agree on the store dir.
 * Path-keyed and local-first: a worktree on a branch keys its OWN entry (wave-1's
 * `realpath(git-common-dir)` made all worktrees share one — deliberately replaced).
 */
export function repoKeyOf(review: Review): string {
  return escapePath(realpathSync(activePatchset(review).repository.root));
}

/**
 * The RepoRecord resolver (T0 spine): `{ repoKey, baseOid }` for a review —
 * `repoKey = escapePath(realpath(git-top-level))`, `baseOid =
 * activePatchset.repository.baseOid`. The one place these two are minted together;
 * `resolveContextFor`/`resolveNoveltyFor` close over the same `repoKey`.
 */
export function repoRecordOf(review: Review): RepoRecord {
  return { repoKey: repoKeyOf(review), baseOid: activePatchset(review).repository.baseOid };
}

/** The produced manifest for a review plus the assembly it was built from (its `text` is byte-identical). */
export interface ReviewContextManifest {
  readonly manifest: ContextManifest;
  readonly assembly: ContextAssembly;
}

/** Inputs for {@link buildReviewContextManifest}. */
export interface BuildReviewContextManifestDeps {
  readonly store: ProjectSnapshotStore;
  readonly review: Review;
  readonly git?: GitExec;
  readonly compositionStore?: RepoCompositionStore;
  readonly byteBudget?: number;
}

/**
 * Build the "what was sent" {@link ContextManifest} for a review from the composed
 * repo + the deterministic, byte-budgeted assembly (issue #30). This is the ONE
 * producer both the live backend (on open) and the desktop canvases path reuse, so
 * the manifest the renderer sees is BYTE-IDENTICAL to the one persisted — same
 * inputs, same code, same bytes.
 *
 * Fail-safe (Rule Zero): when no snapshot exists for the review's pinned base OID
 * (or composition throws), this returns `undefined` — an honest absence the caller
 * surfaces as "no manifest for this review", never a fabricated stand-in.
 */
export async function buildReviewContextManifest(
  deps: BuildReviewContextManifestDeps,
): Promise<ReviewContextManifest | undefined> {
  const git = deps.git ?? execaGit;
  const { repoKey, baseOid } = repoRecordOf(deps.review);
  try {
    const nested = new NestedProjectContext(
      deps.store,
      deps.compositionStore ?? new RepoCompositionStore(deps.store),
      git,
    );
    const composition = await nested.composeRepo(deps.review.repositoryRoot, repoKey, baseOid);
    // Repo guidance feeds the assembly directly, labelled by source (no gate).
    const assembly = assembleContextForComposition(
      deps.review.repositoryRoot,
      composition,
      deps.byteBudget,
    );
    return { manifest: nested.manifest(composition, assembly), assembly };
  } catch {
    return undefined;
  }
}

/**
 * Build the `{repoKey, baseOid}` resolver for `context.map`/`context.file`. `repoKey`
 * is stable for a repo (closed over); `baseOid` is re-read from the LIVE review on
 * every call, so a re-capture that swaps the active patchset re-pins the base with
 * no extra wiring (the reader then refuses anything not fresh at the new OID).
 */
export function resolveContextFor(review: Review, repoKey: string): () => ResolvedRepoContext {
  return () => ({ repoKey, baseOid: activePatchset(review).repository.baseOid });
}

/**
 * Build the `{repoKey, patchset}` resolver for `context.novelty`. The reader pins
 * the snapshot to the resolved patchset's own `repository.baseOid`, so this too
 * re-pins on re-capture (the seam `novelty-ledger-backend.ts` flagged in its header).
 */
export function resolveNoveltyFor(review: Review, repoKey: string): () => ResolvedNoveltyContext {
  return () => ({ repoKey, patchset: activePatchset(review) });
}

/** Everything the core factory needs plus the composition-root wiring inputs. */
export interface LiveBackendDeps {
  /** The app-owned ProjectSnapshot store (its location is the app's to own). */
  readonly store: ProjectSnapshotStore;
  /** The git exec (defaults to the real one). Injected for hermetic tests. */
  readonly git?: GitExec;
  /**
   * The file-count ceiling above which snapshot generation is skipped (fail-closed
   * degradation to a typed `absent`, lenses unaffected). Defaults to 20000.
   */
  readonly maxSnapshotFiles?: number;
  /** Optional model port; when present, missing knowledge is enriched in the background. */
  readonly knowledgePort?: HarnessPort;
  readonly resolveKnowledgePort?: () => Promise<HarnessPort | null>;
  readonly onKnowledgeError?: (error: unknown) => void;
  readonly noveltyLifecycle?: NoveltyLifecycleRegistry;
  readonly compositionStore?: RepoCompositionStore;
  /** Extra core state the composition root may supply (freshness, ledger, effect sink). */
  readonly core?: Omit<ReviewBackendState, "review" | "pipeline">;
}

/** The outcome of the snapshot-on-open generation, for honest reporting/telemetry. */
export interface LiveSnapshotOutcome {
  /** Whether a fresh snapshot was generated + advanced at the pinned base OID. */
  readonly generated: boolean;
  /** The RepoRecord key the snapshot is stored under. */
  readonly repoKey: string;
  /** The review's pinned base OID the snapshot targets. */
  readonly baseOid: string;
  /** Present when generation was skipped/failed (fail-closed) — the reason, for logs. */
  readonly degradedReason?: string;
}

/** The composed live backend plus the snapshot-on-open outcome. */
export interface LiveReviewBackend {
  readonly backend: CanvasOpsBackend;
  readonly snapshot: LiveSnapshotOutcome;
  readonly contextManifest?: ContextManifest;
}

const DEFAULT_MAX_SNAPSHOT_FILES = 20_000;

/**
 * Compose the production `CanvasOpsBackend` for a freshly opened review: generate
 * the snapshot at the pinned base OID (fail-closed, size-gated), construct the
 * store-backed readers, and spread `reviewBackendCore` with the two Repo-Map
 * slices into one backend. The built `pipeline` (canvases/lenses) is supplied by
 * the caller's producer path and is NEVER rebuilt or gated here.
 */
export async function createLiveCanvasOpsBackend(
  review: Review,
  pipeline: ReviewBackendState["pipeline"],
  deps: LiveBackendDeps,
): Promise<LiveReviewBackend> {
  const git = deps.git ?? execaGit;
  const patchset = activePatchset(review);
  const baseOid = patchset.repository.baseOid;
  const repoKey = repoKeyOf(review);
  const maxFiles = deps.maxSnapshotFiles ?? DEFAULT_MAX_SNAPSHOT_FILES;

  resolveMapSource(deps.store, repoKey, review.repositoryRoot);
  const overlayStore = new SnapshotOverlayStore(deps.store);
  const overlayReader = new SnapshotOverlayReader({ store: deps.store, overlayStore });
  const outcome = await generateSnapshotOnOpen(review, baseOid, repoKey, {
    store: deps.store,
    overlayStore,
    git,
    maxFiles,
  });
  // The "what was sent" manifest (issue #30): produce it from the SAME composition +
  // deterministic assembly the desktop canvases path reuses (via
  // `buildReviewContextManifest`), then PERSIST it under the R55 project entry so it
  // reloads across restart. A snapshot that could not be composed yields an honest
  // `undefined` — never a fabricated stand-in (Rule Zero).
  const built = await buildReviewContextManifest({
    store: deps.store,
    review,
    git,
    ...(deps.compositionStore ? { compositionStore: deps.compositionStore } : {}),
  });
  const contextManifest: ContextManifest | undefined = built?.manifest;
  if (built) {
    try {
      new ContextManifestStore(deps.store).save(repoKey, baseOid, built.manifest);
    } catch (error) {
      deps.onKnowledgeError?.(error);
    }
  }

  // The fail-closed read gate is constructed regardless of the generation
  // outcome: with no fresh snapshot, every context read returns a typed refusal.
  const reader = new ProjectContextReader(deps.store, overlayReader);
  const noveltyReader = new NoveltyLedgerReader(
    new ProjectContextReader(deps.store),
    overlayReader,
  );
  let liveNovelty = await noveltyReader.classifyWithGitlinks(
    review.repositoryRoot,
    repoKey,
    patchset,
    git,
  );
  if (liveNovelty.ok && deps.noveltyLifecycle) {
    const followsDefault = deps.store.loadManifest(repoKey)?.baseOid === baseOid;
    deps.noveltyLifecycle.register(
      repoKey,
      review.id,
      { ledger: liveNovelty.ledger, judgments: new Map() },
      async () => {
        const current = deps.store.loadManifest(repoKey);
        if (!current) return { ok: false, failure: { reason: "absent" } };
        if (!followsDefault && current.baseOid !== baseOid) {
          await new SnapshotOverlayGenerator({
            store: deps.store,
            overlayStore,
            git,
          }).ensureOverlay(review.repositoryRoot, repoKey, baseOid);
        }
        const effectiveBaseOid = followsDefault ? current.baseOid : baseOid;
        const projectSnapshotId = followsDefault
          ? current.fingerprint
          : projectSnapshotPinResolver(deps.store, overlayReader)(
              review.repositoryRoot,
              effectiveBaseOid,
            );
        const refreshed = await noveltyReader.classifyWithGitlinks(
          review.repositoryRoot,
          repoKey,
          {
            ...patchset,
            repository: { ...patchset.repository, baseOid: effectiveBaseOid },
            ...(projectSnapshotId ? { projectSnapshotId } : {}),
          },
          git,
        );
        liveNovelty = refreshed;
        return refreshed;
      },
    );
  }

  // Knowledge (layer c): seed a committed set into the local store if present (a
  // committed set is never trusted blind — `discoverCommitted` validates first),
  // then bind the model-free READ accessor against the same fail-closed gate. An
  // absent set is an honest empty view; a review never blocks on knowledge.
  const knowledgeStore = new KnowledgeStore(deps.store);
  knowledgeStore.discoverCommitted(repoKey, review.repositoryRoot);
  const currentBase = deps.store.loadManifest(repoKey);
  if (!knowledgeStore.loadLocal(repoKey) && currentBase) {
    void (async () => {
      const port = deps.knowledgePort ?? (await deps.resolveKnowledgePort?.());
      if (!port) return;
      await enrichKnowledgeForRepo({
        reader: new ProjectContextReader(deps.store),
        knowledgeStore,
        port,
        repoKey,
        repoRoot: review.repositoryRoot,
        baseOid: currentBase.baseOid,
      });
    })().catch((error) => deps.onKnowledgeError?.(error));
  }

  const core = reviewBackendCore({ review, pipeline, ...deps.core });
  const contextPart = projectContextBackend(reader, resolveContextFor(review, repoKey));
  const noveltyPart = noveltyBackend(
    noveltyReader,
    resolveNoveltyFor(review, repoKey),
    () => liveNovelty,
  );
  const knowledgePart = knowledgeBackend(
    reader,
    knowledgeStore,
    resolveContextFor(review, repoKey),
  );
  // `context.ask` (issue #15): the one model-backed tool. Binds the pure runner to
  // the same fail-closed reader + local knowledge store, resolving the answering
  // harness lazily (the user's own `claude`), routed through the council seats.
  const askPart = contextAskBackend({
    reader,
    knowledgeStore,
    resolve: resolveContextFor(review, repoKey),
    resolvePort: async () => deps.knowledgePort ?? (await deps.resolveKnowledgePort?.()) ?? null,
    repoRoot: review.repositoryRoot,
  });

  const backend: CanvasOpsBackend = {
    ...core,
    ...contextPart,
    ...noveltyPart,
    ...knowledgePart,
    ...askPart,
  };

  return {
    backend,
    snapshot: { generated: outcome.generated, repoKey, baseOid, degradedReason: outcome.reason },
    ...(contextManifest ? { contextManifest } : {}),
  };
}

/**
 * Generate + advance the snapshot at the pinned base OID. Model-free, fail-closed,
 * and size-gated. A throw (bad OID, git failure) or an oversize repo degrades to a
 * NON-generation, and the caller's readers then gate every context read to a typed
 * refusal — review creation never fabricates a snapshot and never hangs the lenses.
 */
async function generateSnapshotOnOpen(
  review: Review,
  baseOid: string,
  repoKey: string,
  opts: {
    store: ProjectSnapshotStore;
    overlayStore: SnapshotOverlayStore;
    git: GitExec;
    maxFiles: number;
  },
): Promise<{ generated: boolean; reason?: string }> {
  const generator = new ProjectSnapshotGenerator({ git: opts.git, store: opts.store });
  try {
    let defaultBase: ResolvedBase;
    try {
      defaultBase = await resolveBaseRef(review.repositoryRoot, { git: opts.git });
    } catch {
      defaultBase = await resolveBaseRef(review.repositoryRoot, {
        git: opts.git,
        explicitBaseRef: activePatchset(review).repository.baseRef,
      });
    }
    // Size gate BEFORE the build (and before any symbol extraction): a git ls-tree
    // at the pinned OID is cheap; refusing an oversize repo keeps open synchronous
    // without a runaway build.
    const gathered = await generator.gather(review.repositoryRoot, {
      explicitBaseRef: defaultBase.baseOid,
    });
    if (gathered.inputs.files.length > opts.maxFiles) {
      return {
        generated: false,
        reason: `over size ceiling (${gathered.inputs.files.length} files)`,
      };
    }
    // Pin generation to the review's OWN base OID (a SHA resolves to itself), so
    // the stored `manifest.baseOid` equals what `resolveContext` requests and the
    // reader serves it fresh rather than refusing it as stale.
    if (opts.store.loadManifest(repoKey)?.baseOid !== defaultBase.baseOid) {
      await generator.generate(review.repositoryRoot, { explicitBaseRef: defaultBase.baseOid });
    }
    if (baseOid !== defaultBase.baseOid) {
      const overlays = new SnapshotOverlayGenerator({
        store: opts.store,
        overlayStore: opts.overlayStore,
        git: opts.git,
      });
      const overlay = await overlays.ensureOverlay(review.repositoryRoot, repoKey, baseOid);
      if (!overlay.ok) return { generated: false, reason: overlay.reason };
    }
    return { generated: true };
  } catch (error) {
    return { generated: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
