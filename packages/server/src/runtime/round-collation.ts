// ─────────────────────────────────────────────────────────────────────────────
// The round collation bridge (C15 cluster 1, tasks 1.2–1.3). `runRound`'s
// `RoundInput` needs a flat `LintHunk[]` and a per-lens `lintContextFor` that the
// lens pipeline's coverage/lint consume; no production path built these before
// C15. These two PURE builders turn an (immutable) patchset + its `HunkIndex`
// into exactly those shapes. Pure and I/O-free — the trigger (1.5) supplies the
// patchset, these derive the collation universe.
// ─────────────────────────────────────────────────────────────────────────────

import type { DesignArtifactSet } from "@rennet/adapters";
import {
  buildDeltaPacket,
  type DeltaPacket,
  type DeltaPacketFile,
  type FanInIndex,
  fanInIndexFromSnapshot,
  type HunkIndex,
  type LintContext,
  type LintHunk,
  type LintTarget,
  type LoadedSnapshot,
  type RegisterLintContext,
  selectPacketKnowledge,
} from "@rennet/core";
import {
  type AskOccurrence,
  type DossierItem,
  type DraftBoard,
  type Generation,
  generationIdForPatchset,
  type KnowledgeSet,
  LENS_KINDS,
  type LensKind,
  type PatchFile,
  type Patchset,
  parseDraft,
  type Review,
  type RoundEvent,
  type SessionModel,
  type SuccessorAccount,
} from "@rennet/protocol";
import type { LensPipelineDeps, RoundDraftContext } from "./lens-pipeline";
import type { RoundDraftPlan, RoundInput, WorkerReturn } from "./rounds";

/**
 * Map a patchset's `IndexedHunk`s (whose spans are `{ new: {start,lines}, old:
 * {start,lines} }`) to the FLAT `LintHunk` `{ id, path, newStart, newLines,
 * oldStart, oldLines, previousPath? }` shape the pipeline's `assertCoverage` and
 * lint consume (`lint.ts`). The base-side `previousPath` is set only for a RENAMED
 * file (a `side:"base"` code_ref then resolves against the old path); an
 * unrenamed file's base path defaults to `path` inside `codeRefTeaches`, so it is
 * omitted here. Pure.
 */
export function toLintHunks(
  hunks: HunkIndex,
  files: readonly (DeltaPacketFile | PatchFile)[],
): LintHunk[] {
  const previousPathByPath = new Map<string, string>();
  for (const file of files) {
    if (file.status === "renamed" && file.previousPath !== undefined) {
      previousPathByPath.set(file.path, file.previousPath);
    }
  }
  return hunks.hunks.map((hunk): LintHunk => {
    const previousPath = previousPathByPath.get(hunk.path);
    return {
      id: hunk.id,
      path: hunk.path,
      newStart: hunk.spans.new.start,
      newLines: hunk.spans.new.lines,
      oldStart: hunk.spans.old.start,
      oldLines: hunk.spans.old.lines,
      ...(previousPath === undefined ? {} : { previousPath }),
    };
  });
}

/**
 * The HEAD-side (post-image) file → line-count inventory a board's citations
 * resolve against. A patchset does not carry file line counts (it carries diffs),
 * so the head inventory is derived per file from its patch: the count of context
 * (` `) + added (`+`) lines across every hunk is the file's post-image line span
 * touched by the change. Deleted files contribute no head inventory. This is the
 * inventory `checkCitationResolves` needs to reject a citation past a file's end;
 * a citation inside a hunk's own range always resolves (the change is teachable).
 */
function headFileInventory(files: readonly PatchFile[]): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const file of files) {
    if (file.status === "deleted" || file.binary) continue;
    // The highest post-image line the patch reaches: a hunk covers
    // `newStart .. newStart + newLines - 1`, so the max end across hunks is the
    // head-side extent the citations can address.
    let maxLine = 0;
    for (const match of file.patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]);
      const lines = match[2] === undefined ? 1 : Number(match[2]);
      maxLine = Math.max(maxLine, start + Math.max(lines, 1) - 1);
    }
    inventory.set(file.path, maxLine);
  }
  return inventory;
}

/** The BASE-side (pre-image) inventory a `side:"base"` code_ref resolves against. */
function baseFileInventory(files: readonly PatchFile[]): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const file of files) {
    if (file.status === "added" || file.binary) continue;
    const basePath = file.previousPath ?? file.path;
    let maxLine = 0;
    for (const match of file.patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
      const start = Number(match[1]);
      const lines = match[2] === undefined ? 1 : Number(match[2]);
      maxLine = Math.max(maxLine, start + Math.max(lines, 1) - 1);
    }
    inventory.set(basePath, maxLine);
  }
  return inventory;
}

/**
 * The FULL tree inventories at the review commit — `path → line count` for every
 * text file at head, and the same at base. Read from git by the composition root
 * ({@link BoardRegenerationDeps.fileInventory}); absent when git could not answer.
 */
export interface TreeInventories {
  readonly head: ReadonlyMap<string, number>;
  readonly base: ReadonlyMap<string, number>;
}

/**
 * The HEAD-side inventory every citation in this round resolves against — the
 * diff-derived counts widened by the whole-tree read. Shared by the lens boards
 * and the composed review draft, because they cite the same commit.
 */
function mergedHeadInventory(
  patchset: Patchset,
  tree: TreeInventories | undefined,
): Map<string, number> {
  return mergeByMax(headFileInventory(patchset.files), tree?.head);
}

/** Union two line-count inventories, keeping the HIGHER count for a shared path. */
function mergeByMax(
  diff: ReadonlyMap<string, number>,
  tree: ReadonlyMap<string, number> | undefined,
): Map<string, number> {
  const merged = new Map(diff);
  for (const [path, lines] of tree ?? []) {
    merged.set(path, Math.max(lines, merged.get(path) ?? 0));
  }
  return merged;
}

/**
 * Build the per-lens `lintContextFor` the round pipeline calls once per board. The
 * hunk list + file inventories + patchsetId are the SAME for every lens (a board
 * of any lens may cite or skip any patchset hunk — `ctx.hunks` gates skip
 * resolution and taught/skipped coherence, not a per-lens partition); only
 * `ctx.lens` varies. `scaffoldGlobs` is left to the lint default. Pure — returns a
 * `(lens) => LintContext` closure over the derived universe.
 *
 * W5 — grounding is the WHOLE TREE, not the diff. Drafters are free to read past
 * the changed files, and a drafter that does so cites what it read. Grounding the
 * `citation-resolves` rule on `patchset.files` alone made every such citation
 * unresolvable, so the pipeline DELETED correct work with no signal to the seat
 * that wrote it. `tree`, when the caller could read it, is the real inventory at
 * the review commit: it carries a file's true line count, where the patch can only
 * bound the extent its own hunks reach. The diff-derived maps stay underneath as
 * the honest degrade when git could not answer, and they still cover a file the
 * tree read skipped (a patch text git calls binary). Citations must still
 * RESOLVE — this widens where they may point, never whether they must land.
 *
 * The two are merged by MAX, never by override. For a file both know, the tree is
 * usually the larger and the citation ceiling rises to the real end of the file.
 * But a working-tree review's patch describes UNCOMMITTED content while the tree
 * read is pinned to the commit, so the tree can be the SHORTER of the two — taking
 * it would reject a citation inside the change's own hunk, which is the very thing
 * that always resolved before. Max cannot regress: every citation lint accepts
 * today is still accepted.
 */
export function buildLintContextFor(
  patchset: Patchset,
  hunks: readonly LintHunk[],
  tree?: TreeInventories,
): (lens: LintTarget) => LintContext {
  const files = mergedHeadInventory(patchset, tree);
  const baseFiles = mergeByMax(baseFileInventory(patchset.files), tree?.base);
  return (lens: LintTarget): LintContext => ({
    lens,
    hunks,
    files,
    baseFiles,
    patchsetId: patchset.id,
  });
}

/** The per-round pipeline inputs `runRound`'s `RoundInput` carries. */
export interface RoundCollation {
  readonly deltaPacket: DeltaPacket;
  readonly hunks: readonly LintHunk[];
  readonly lintContextFor: (lens: LintTarget) => LintContext;
  /**
   * The composed review draft's citation grounding — the SAME head inventory the
   * lens boards resolve against.
   *
   * Without it the composition lint falls back to an EMPTY inventory, and every
   * real `path:line` in the draft reports "does not resolve: no such file at the
   * review commit". That violation is visible-never-blocking, so nothing is deleted
   * — but the surface the reviewer actually reads is then papered with false
   * ungrounded marks. It is the same grounding bug the lens boards had, one layer up.
   */
  readonly reviewDraftLintCtx: RegisterLintContext;
}

/** Every path the patchset touches — BOTH sides of a rename, since a statement anchored
 *  on the old path is exactly as relevant as one anchored on the new. */
function changedPathsOf(patchset: Patchset): string[] {
  const paths = new Set<string>();
  for (const file of patchset.files) {
    paths.add(file.path);
    if (file.previousPath !== undefined) paths.add(file.previousPath);
  }
  return [...paths];
}

/**
 * The blast-radius fan-in index for a snapshot, or `undefined` when the snapshot
 * cannot genuinely answer "what depends on this file?".
 *
 * This is the composition side of `fanInIndexFromSnapshot`'s contract: supplying an
 * index at all is the ASSESSED signal, so it must be supplied only when POPULATED.
 * The `import-edges` arm is populated by construction (that builder returns it only
 * when the graph resolved with edges). The `textual` arm is not — over a snapshot
 * with no identifier-occurrence shards it answers "zero dependents" for every file,
 * which would render as "checked, nothing depends on this" when nothing was checked.
 *
 * The textual arm needs BOTH shard families, because its lookup is a JOIN across
 * them: `definedSymbols` reads the SYMBOL shards and `referencingFiles` the
 * REFERENCE shards. With symbols missing, every changed file defines nothing and
 * every count is zero — the same silent zero reached from the other side — so both
 * digests are required, not the reference one alone.
 */
function packetFanIn(snapshot: LoadedSnapshot): FanInIndex | undefined {
  const index = fanInIndexFromSnapshot(snapshot);
  if (index.method === "import-edges") return index;
  return snapshot.referenceDigestByBlob.size > 0 && snapshot.symbolDigestByBlob.size > 0
    ? index
    : undefined;
}

/**
 * Assemble the collation context `runRound` needs from a patchset + its protocol
 * contracts (C15 task 1.4): thread the ALREADY-BUILT `successorAccount` (stamped on
 * the review at patchset activation, `core/src/index.ts`) through `buildDeltaPacket`,
 * then derive the flat `LintHunk[]` and the per-lens `lintContextFor` off the same
 * packet. When a successor account is present the packet carries it, so the pipeline's
 * `isRound` branch fires (the round-report drafts first); when it is absent the packet
 * is a first-generation (non-round) draft — the honest degrade, never a crash.
 *
 * This is also where the packet meets the SNAPSHOT (context-map rebuild, W5b). Given
 * one, two things stop being dishonest at once: the knowledge field becomes a
 * projected, change-scoped, capped selection instead of the whole stored set dumped
 * unprojected (`selectPacketKnowledge`), and fan-in becomes an edge-backed count
 * instead of a NOT-ASSESSED mark (`packetFanIn`). Without one, both degrade loudly —
 * the packet says which mode it got, and never quietly offers less.
 *
 * Pure over its inputs; the caller owns loading the snapshot.
 */
export function assembleRoundCollation(input: {
  patchset: Patchset;
  /** The stored knowledge set, or null when the repo has never been enriched. */
  knowledge: KnowledgeSet | null;
  /** The snapshot gated fresh at the patchset's base OID; omitted when the gate refused. */
  snapshot?: LoadedSnapshot;
  dossier: readonly DossierItem[];
  successorAccount?: SuccessorAccount;
  /** The full head/base tree inventories citations resolve against (W5). Absent ⇒
   *  the diff-derived inventories alone (the honest degrade). */
  tree?: TreeInventories;
}): RoundCollation {
  const snapshot = input.snapshot ?? null;
  const knowledge = selectPacketKnowledge({
    set: input.knowledge,
    snapshot,
    changedPaths: changedPathsOf(input.patchset),
  });
  const fanIn = snapshot === null ? undefined : packetFanIn(snapshot);
  const deltaPacket = buildDeltaPacket(
    input.patchset,
    knowledge,
    input.dossier,
    input.successorAccount,
    fanIn,
  );
  const hunks = toLintHunks(deltaPacket.hunks, input.patchset.files);
  const lintContextFor = buildLintContextFor(input.patchset, hunks, input.tree);
  return {
    deltaPacket,
    hunks,
    lintContextFor,
    reviewDraftLintCtx: { files: mergedHeadInventory(input.patchset, input.tree) },
  };
}

// ── The prior generation (C15 2.1/3.3) — the lineage a round actually has ────

/**
 * What the packet's knowledge field is selected FROM: the stored set and the
 * snapshot to project and scope it against. Kept as one value because the two are
 * read for the same patchset and must describe the same base OID.
 */
export interface PacketKnowledgeSource {
  readonly set: KnowledgeSet | null;
  readonly snapshot: LoadedSnapshot | null;
  /** Content identity of the exact snapshot + knowledge pair above. */
  readonly revision?: string;
}

/** A prior generation and the boards it really drafted — the delta stamps' comparison set. */
export interface PriorGeneration {
  readonly generation: Generation;
  readonly boards: ReadonlyMap<LintTarget, DraftBoard>;
}

/** The durable halves a prior generation is rebuilt from: the generation record, the
 *  board-meta rows for its (session, generation), and each board's projected elements. */
export interface PriorGenerationReaders {
  readonly loadGeneration: (id: string) => Generation | undefined;
  readonly listBoardMeta: (
    sessionId: string,
    generation: string,
  ) => readonly { readonly lens: LintTarget; readonly boardId: string }[];
  readonly boardElements: (boardId: string) => Promise<readonly unknown[]>;
}

/** Select the one BoardMeta row the persisted Generation names for a lens. Recovery
 *  redrafts deliberately leave abandoned partial rows on disk, so lens alone is not an
 *  identity and first/last-wins would serve stale work. */
export function generationBoardMeta<
  T extends { readonly lens: LintTarget; readonly boardId: string },
>(generation: Generation, records: readonly T[], lens: LensKind): T | undefined {
  const boardId = generation.lensBoards[lens];
  if (boardId === undefined) return undefined;
  return records.find((record) => record.lens === lens && record.boardId === boardId);
}

/**
 * Read the REAL prior generation for a session — the record plus the boards it drafted,
 * rebuilt from the whiteboard's projected element state.
 *
 * This is what makes carry-forward possible at all. `stampDeltas` compares each section's
 * subtree signature against the SAME section on the previous generation's board; with no
 * previous board every section stamps `new`, so a lane can never honestly say "carrying
 * forward" — which is its own dishonesty, the mirror of a lane that lies that it did.
 *
 * Honest absence throughout: a generation that was never minted returns `undefined` (a
 * first generation, no lineage to claim), and a persisted board whose elements no longer
 * parse as a draft is SKIPPED rather than half-read — its lens then stamps `new`, because
 * nothing here can prove it carried.
 */
export async function readPriorGeneration(
  readers: PriorGenerationReaders,
  sessionId: string,
  generationId: string,
): Promise<PriorGeneration | undefined> {
  const generation = readers.loadGeneration(generationId);
  if (generation === undefined) return undefined;
  const boards = new Map<LintTarget, DraftBoard>();
  const records = readers.listBoardMeta(sessionId, generationId);
  for (const lens of LENS_KINDS) {
    const meta = generationBoardMeta(generation, records, lens);
    if (meta === undefined) continue;
    const parsed = parseDraft({ elements: await readers.boardElements(meta.boardId) });
    if (parsed.ok) boards.set(lens, parsed.value);
  }
  return { generation, boards };
}

// ── The post-round regeneration (C15 1.5) — the ORDER is the honesty ─────────

/**
 * The seams the post-round board regeneration reads and writes. Each one is the REAL
 * production seam (`review.regenerate`, the review store, `runRound`); this function owns
 * only the ORDER they run in — which is exactly where the honesty lives.
 */
export interface BoardRegenerationDeps {
  /** Re-capture the worker's tree as the successor patchset — the same `review.regenerate`
   *  the reviewer's own refresh runs. Called only when the worker turn moved code. */
  readonly recapture: () => Promise<void>;
  /** The review as it stands NOW. Read AFTER {@link recapture}, never a pre-round closure. */
  readonly reviewNow: () => Review;
  /** The repo's knowledge set + gated snapshot for the drafters' packet, over the patchset
   *  they will read. Both halves are nullable and independently so: a repo can be mapped
   *  but not yet enriched, and an enriched repo's snapshot can fail the freshness gate. */
  readonly knowledgeFor: (patchset: Patchset) => PacketKnowledgeSource;
  /** The REAL prior generation + its drafted boards, or `undefined` for a first generation
   *  ({@link readPriorGeneration} over the durable stores in production). */
  readonly priorGeneration: (generationId: string) => Promise<PriorGeneration | undefined>;
  /** The FULL head/base tree inventories at the review commit, for citation grounding
   *  (W5). A drafter is free to read past the diff, so lint must be able to resolve a
   *  citation past the diff. Rejecting/throwing degrades to the diff-derived
   *  inventories rather than failing the regeneration. */
  readonly fileInventory?: (patchset: Patchset) => Promise<TreeInventories>;
  /** Deterministic spec discovery at the reviewed state; null is a successful no-spec result.
   *  A throw settles Design as failed while the other lenses continue. */
  readonly designArtifactsFor?: (patchset: Patchset) => Promise<DesignArtifactSet | null>;
  /** Re-read the reviewer overlay at the exact Flagged composition boundary. */
  readonly readFindingDispositions?: LensPipelineDeps["readFindingDispositions"];
  /** Persist reviewer-owned finding reattachments before Flagged is written. */
  readonly persistFindingResolutions?: LensPipelineDeps["persistFindingResolutions"];
  readonly runRound: (input: RoundInput) => Promise<unknown>;
  /** The live round-progress sink — the same channel the dispatch half emits on. */
  readonly emit: (event: RoundEvent) => void;
}

export interface BoardRegenerationInput {
  readonly session: SessionModel;
  readonly repoRoot: string;
  /** Board and generation ids reserved by the durable operation before drafting. */
  readonly draftPlan?: RoundDraftPlan;
  /** The coordinator already activated the exact successor patchset while reserving
   * the durable report/generation ids. Legacy callers leave this absent. */
  readonly recaptured?: boolean;
  /** The patchset the boards described BEFORE this round — the generation it succeeds. */
  readonly priorPatchsetId: string;
  /** The durable generation currently visible for that patchset. Passive regeneration after
   * a real round must follow the ledger-selected generation instead of the initial
   * content-derived address. */
  readonly priorGenerationId?: string;
  readonly asksDispatched: readonly string[];
  /** Stable dispatch identity; absent only for askless first-generation drafting. */
  readonly dispatchId?: string;
  readonly sourcePatchsetId?: string;
  readonly askOccurrences?: readonly AskOccurrence[];
  /** Present only for an actual durable-ask dispatch; absent on first-board drafting. */
  readonly round?: RoundDraftContext;
  /** Checkpoint-measured truth from the coding turn. The harness intentionally leaves
   *  edits uncommitted, so HEAD movement is not a change signal. */
  readonly worked: {
    readonly commitRange: WorkerReturn["commitRange"];
    readonly diff: string;
    readonly changedPaths: readonly string[];
  };
  /** Operation-scoped report verifier, passed through to the runtime's pre-commit seam. */
  readonly verifyDraftedReport?: RoundInput["verifyDraftedReport"];
  /** Cancels model-backed lens work for an initial preparation or an owning operation. */
  readonly signal?: AbortSignal;
}

type DesignArtifactDiscovery =
  | { readonly status: "legacy" }
  | { readonly status: "available"; readonly artifacts: DesignArtifactSet | null }
  | { readonly status: "unavailable"; readonly reason: string };

/** Preserve the semantic difference between an old host, a completed pinned read,
 *  and a pinned read that failed. Only the old host may use legacy repo discovery. */
async function discoverDesignArtifactsFor(
  reader: BoardRegenerationDeps["designArtifactsFor"],
  patchset: Patchset,
): Promise<DesignArtifactDiscovery> {
  if (reader === undefined) return { status: "legacy" };
  try {
    return { status: "available", artifacts: await reader(patchset) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      reason: `Design artifact discovery failed for the pinned reviewed tree: ${detail}`,
    };
  }
}

/**
 * Regenerate the lens boards over what the round's worker actually produced.
 *
 * The load-bearing step is the FIRST one. The boards must describe the POST-rework tree:
 * drafting over the pre-worker patchset would describe the diff this round just CHANGED,
 * while the UI calls it the delta — the worst kind of lie, because it reads as a real
 * answer. So the successor patchset is captured BEFORE the collation is assembled, through
 * the same `review.regenerate` the reviewer's own refresh runs; that activation also stamps
 * the REAL `successorAccount` for THIS round (what each ask did), which is the signal that
 * makes the pipeline draft as a round at all.
 *
 * Failure-isolated but never silent: the worker's committed work and its recorded round
 * already landed, so a regeneration hiccup does not unwind them — but the live channel
 * always closes on a terminal event, because a run left mid-phase reads as "still working".
 */
export async function runBoardRegeneration(
  deps: BoardRegenerationDeps,
  input: BoardRegenerationInput,
): Promise<boolean> {
  try {
    const workerChangedTree =
      input.worked.changedPaths.length > 0 || input.worked.diff.trim().length > 0;
    if (workerChangedTree && input.recaptured !== true) await deps.recapture();
    const review = deps.reviewNow();
    const successor = review.patchsets.find((p) => p.id === review.activePatchsetId);
    if (successor === undefined) {
      deps.emit({ type: "failed", reason: "No active patchset to regenerate the boards over." });
      return false;
    }
    // The code MOVED iff the re-captured patchset is a DIFFERENT one. Patchset ids are
    // content-derived, so this is the honest test: a turn that committed no net change
    // keeps the existing generation and has no successor report to draft.
    const landed = successor.id !== input.priorPatchsetId;
    const knowledgeSource = deps.knowledgeFor(successor);
    // The whole-tree citation grounding (W5). Best-effort by design: a tree git
    // could not read still drafts — on the diff-derived inventories, the behaviour
    // before this change — rather than sinking the round over a lint input. The
    // try/catch covers a synchronous throw as well as a rejection, so a broken
    // reader degrades instead of reaching the outer handler and failing the round.
    let tree: TreeInventories | undefined;
    try {
      tree = await deps.fileInventory?.(successor);
    } catch {
      tree = undefined;
    }
    const designDiscovery = await discoverDesignArtifactsFor(deps.designArtifactsFor, successor);
    let designArtifactInput: Pick<RoundInput, "designArtifacts" | "designArtifactFailure">;
    switch (designDiscovery.status) {
      case "legacy":
        designArtifactInput = {};
        break;
      case "available":
        designArtifactInput = { designArtifacts: designDiscovery.artifacts };
        break;
      case "unavailable":
        designArtifactInput = { designArtifactFailure: designDiscovery.reason };
        break;
      default: {
        const exhaustive: never = designDiscovery;
        return exhaustive;
      }
    }
    const collation = assembleRoundCollation({
      patchset: successor,
      knowledge: knowledgeSource.set,
      ...(knowledgeSource.snapshot === null ? {} : { snapshot: knowledgeSource.snapshot }),
      // Dossier is the related-context tray (a separate producer); an empty dossier is
      // honest — the drafters simply have no tracker items inlined this round.
      dossier: [],
      ...(landed && review.successorAccount ? { successorAccount: review.successorAccount } : {}),
      ...(tree === undefined ? {} : { tree }),
    });
    // The lineage this round ACTUALLY has. A prior generation counts only if it was really
    // minted and persisted; otherwise this is a first generation and says so — no
    // synthesized predecessor for the ledger to drill into, and no phantom comparison set.
    const prior = await deps.priorGeneration(
      input.round?.previousGeneration ??
        input.priorGenerationId ??
        generationIdForPatchset(input.priorPatchsetId),
    );
    try {
      await deps.runRound({
        session: input.session,
        repoRoot: input.repoRoot,
        ...(input.draftPlan === undefined ? {} : { draftPlan: input.draftPlan }),
        ...(prior === undefined
          ? {}
          : { previousGeneration: prior.generation, previous: prior.boards }),
        asksDispatched: [...input.asksDispatched],
        ...(input.dispatchId === undefined ? {} : { dispatchId: input.dispatchId }),
        ...(input.sourcePatchsetId === undefined
          ? {}
          : { sourcePatchsetId: input.sourcePatchsetId }),
        ...(input.askOccurrences === undefined
          ? {}
          : { askOccurrences: [...input.askOccurrences] }),
        ...(input.verifyDraftedReport === undefined
          ? {}
          : { verifyDraftedReport: input.verifyDraftedReport }),
        ...(knowledgeSource.revision === undefined
          ? {}
          : { projectContextRevision: knowledgeSource.revision }),
        ...(input.round === undefined
          ? {}
          : {
              round: {
                ...input.round,
                worker: {
                  outcome: "completed",
                  diff: input.worked.diff,
                  changedPaths: [...input.worked.changedPaths],
                  commitRange: { ...input.worked.commitRange },
                },
              },
            }),
        ...(deps.readFindingDispositions === undefined
          ? {}
          : { readFindingDispositions: deps.readFindingDispositions }),
        ...(deps.persistFindingResolutions === undefined
          ? {}
          : { persistFindingResolutions: deps.persistFindingResolutions }),
        // The successor PATCHSET id keys the minted generation (not the post-turn HEAD oid),
        // so the generation the boards file under names the diff they actually read.
        runWorkers: async (): Promise<WorkerReturn> => ({
          commitRange: input.worked.commitRange,
          ...(landed ? { patchsetId: successor.id } : {}),
        }),
        onProgress: deps.emit,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...designArtifactInput,
        ...collation,
      });
    } catch {
      // `createRoundsRuntime.runRound` already emitted the terminal failure through this
      // same sink. Return failure to the caller without appending a duplicate event.
      return false;
    }
    return true;
  } catch (error) {
    deps.emit({ type: "failed", reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
