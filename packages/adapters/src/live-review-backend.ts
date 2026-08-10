import { realpathSync } from "node:fs";
import {
  type CanvasOpsBackend,
  escapePath,
  type ReviewBackendState,
  reviewBackendCore,
} from "@rennet/core";
import type { Patchset, Review } from "@rennet/types";
import { execaGit, type GitExec } from "./git-range-diff";
import { knowledgeBackend } from "./knowledge-backend";
import { KnowledgeStore } from "./knowledge-store";
import { noveltyBackend, type ResolvedNoveltyContext } from "./novelty-ledger-backend";
import { NoveltyLedgerReader } from "./novelty-ledger-reader";
import { projectContextBackend, type ResolvedRepoContext } from "./project-context-backend";
import { ProjectContextReader } from "./project-context-reader";
import { ProjectSnapshotGenerator } from "./project-snapshot-generator";
import type { ProjectSnapshotStore } from "./project-snapshot-store";

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

  const outcome = await generateSnapshotOnOpen(review, baseOid, {
    store: deps.store,
    git,
    maxFiles,
  });

  // The fail-closed read gate is constructed regardless of the generation
  // outcome: with no fresh snapshot, every context read returns a typed refusal.
  const reader = new ProjectContextReader(deps.store);
  const noveltyReader = new NoveltyLedgerReader(reader);

  // Knowledge (layer c): seed a committed set into the local store if present (a
  // committed set is never trusted blind — `discoverCommitted` validates first),
  // then bind the model-free READ accessor against the same fail-closed gate. An
  // absent set is an honest empty view; a review never blocks on knowledge.
  const knowledgeStore = new KnowledgeStore(deps.store);
  knowledgeStore.discoverCommitted(repoKey, review.repositoryRoot);

  const core = reviewBackendCore({ review, pipeline, ...deps.core });
  const contextPart = projectContextBackend(reader, resolveContextFor(review, repoKey));
  const noveltyPart = noveltyBackend(noveltyReader, resolveNoveltyFor(review, repoKey));
  const knowledgePart = knowledgeBackend(
    reader,
    knowledgeStore,
    resolveContextFor(review, repoKey),
  );

  const backend: CanvasOpsBackend = { ...core, ...contextPart, ...noveltyPart, ...knowledgePart };

  return {
    backend,
    snapshot: { generated: outcome.generated, repoKey, baseOid, degradedReason: outcome.reason },
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
  opts: { store: ProjectSnapshotStore; git: GitExec; maxFiles: number },
): Promise<{ generated: boolean; reason?: string }> {
  const generator = new ProjectSnapshotGenerator({ git: opts.git, store: opts.store });
  try {
    // Size gate BEFORE the build (and before any symbol extraction): a git ls-tree
    // at the pinned OID is cheap; refusing an oversize repo keeps open synchronous
    // without a runaway build.
    const gathered = await generator.gather(review.repositoryRoot, { explicitBaseRef: baseOid });
    if (gathered.inputs.files.length > opts.maxFiles) {
      return {
        generated: false,
        reason: `over size ceiling (${gathered.inputs.files.length} files)`,
      };
    }
    // Pin generation to the review's OWN base OID (a SHA resolves to itself), so
    // the stored `manifest.baseOid` equals what `resolveContext` requests and the
    // reader serves it fresh rather than refusing it as stale.
    await generator.generate(review.repositoryRoot, { explicitBaseRef: baseOid });
    return { generated: true };
  } catch (error) {
    return { generated: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
