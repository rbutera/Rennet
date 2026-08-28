// ─────────────────────────────────────────────────────────────────────────────
// The round collation bridge (C15 cluster 1, tasks 1.2–1.3). `runRound`'s
// `RoundInput` needs a flat `LintHunk[]` and a per-lens `lintContextFor` that the
// lens pipeline's coverage/lint consume; no production path built these before
// C15. These two PURE builders turn an (immutable) patchset + its `HunkIndex`
// into exactly those shapes. Pure and I/O-free — the trigger (1.5) supplies the
// patchset, these derive the collation universe.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildDeltaPacket,
  type DeltaPacket,
  type DeltaPacketFile,
  type HunkIndex,
  type LintContext,
  type LintHunk,
  type LintTarget,
} from "@rennet/core";
import {
  type DossierItem,
  type DraftBoard,
  type Generation,
  type KnowledgeSet,
  type PatchFile,
  type Patchset,
  parseDraft,
  type Review,
  type RoundEvent,
  type SessionModel,
  type SuccessorAccount,
} from "@rennet/protocol";
import type { RoundInput, WorkerReturn } from "./rounds";

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
 * the review commit and takes precedence: it carries a file's true line count,
 * where the patch can only bound the extent its own hunks reach. The diff-derived
 * maps stay underneath as the honest degrade when git could not answer, and they
 * still cover a file the tree read skipped (a patch text git calls binary).
 * Citations must still RESOLVE — this widens where they may point, never whether
 * they must land.
 */
export function buildLintContextFor(
  patchset: Patchset,
  hunks: readonly LintHunk[],
  tree?: TreeInventories,
): (lens: LintTarget) => LintContext {
  const files = new Map([...headFileInventory(patchset.files), ...(tree?.head ?? [])]);
  const baseFiles = new Map([...baseFileInventory(patchset.files), ...(tree?.base ?? [])]);
  return (lens: LintTarget): LintContext => ({
    lens,
    hunks,
    files,
    baseFiles,
    patchsetId: patchset.id,
  });
}

/** The three per-round pipeline inputs `runRound`'s `RoundInput` carries. */
export interface RoundCollation {
  readonly deltaPacket: DeltaPacket;
  readonly hunks: readonly LintHunk[];
  readonly lintContextFor: (lens: LintTarget) => LintContext;
}

/**
 * Assemble the collation context `runRound` needs from a patchset + its protocol
 * contracts (C15 task 1.4): thread the ALREADY-BUILT `successorAccount` (stamped on
 * the review at patchset activation, `core/src/index.ts`) through `buildDeltaPacket`,
 * then derive the flat `LintHunk[]` and the per-lens `lintContextFor` off the same
 * packet. When a successor account is present the packet carries it, so the pipeline's
 * `isRound` branch fires (the round-report drafts first); when it is absent the packet
 * is a first-generation (non-round) draft — the honest degrade, never a crash. Pure.
 */
export function assembleRoundCollation(input: {
  patchset: Patchset;
  knowledge: KnowledgeSet;
  dossier: readonly DossierItem[];
  successorAccount?: SuccessorAccount;
  /** The full head/base tree inventories citations resolve against (W5). Absent ⇒
   *  the diff-derived inventories alone (the honest degrade). */
  tree?: TreeInventories;
}): RoundCollation {
  const deltaPacket = buildDeltaPacket(
    input.patchset,
    input.knowledge,
    input.dossier,
    input.successorAccount,
  );
  const hunks = toLintHunks(deltaPacket.hunks, input.patchset.files);
  const lintContextFor = buildLintContextFor(input.patchset, hunks, input.tree);
  return { deltaPacket, hunks, lintContextFor };
}

// ── The prior generation (C15 2.1/3.3) — the lineage a round actually has ────

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
  for (const meta of readers.listBoardMeta(sessionId, generationId)) {
    const parsed = parseDraft({ elements: await readers.boardElements(meta.boardId) });
    if (parsed.ok) boards.set(meta.lens, parsed.value);
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
  /** The repo's knowledge set for the drafters' packet, over the patchset they will read. */
  readonly knowledgeFor: (patchset: Patchset) => KnowledgeSet;
  /** The REAL prior generation + its drafted boards, or `undefined` for a first generation
   *  ({@link readPriorGeneration} over the durable stores in production). */
  readonly priorGeneration: (generationId: string) => Promise<PriorGeneration | undefined>;
  /** The FULL head/base tree inventories at the review commit, for citation grounding
   *  (W5). A drafter is free to read past the diff, so lint must be able to resolve a
   *  citation past the diff. Rejecting/throwing degrades to the diff-derived
   *  inventories rather than failing the regeneration. */
  readonly fileInventory?: (patchset: Patchset) => Promise<TreeInventories>;
  readonly runRound: (input: RoundInput) => Promise<unknown>;
  /** The live round-progress sink — the same channel the dispatch half emits on. */
  readonly emit: (event: RoundEvent) => void;
}

export interface BoardRegenerationInput {
  readonly session: SessionModel;
  readonly repoRoot: string;
  /** The patchset the boards described BEFORE this round — the generation it succeeds. */
  readonly priorPatchsetId: string;
  readonly asksDispatched: readonly string[];
  /** What the worker turn produced: its commit range, and a patchset id iff HEAD moved. */
  readonly worked: WorkerReturn;
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
): Promise<void> {
  try {
    if (input.worked.patchsetId !== undefined) await deps.recapture();
    const review = deps.reviewNow();
    const successor = review.patchsets.find((p) => p.id === review.activePatchsetId);
    if (successor === undefined) {
      deps.emit({ type: "failed", reason: "No active patchset to regenerate the boards over." });
      return;
    }
    // The code MOVED iff the re-captured patchset is a DIFFERENT one. Patchset ids are
    // content-derived, so this is the honest test: a turn that committed no net change
    // re-reports against the existing generation instead of minting a hollow successor.
    const landed = successor.id !== input.priorPatchsetId;
    // The whole-tree citation grounding (W5). Best-effort by design: a tree git
    // could not read still drafts — on the diff-derived inventories, the behaviour
    // before this change — rather than sinking the round over a lint input.
    const tree = await deps.fileInventory?.(successor).catch(() => undefined);
    const collation = assembleRoundCollation({
      patchset: successor,
      knowledge: deps.knowledgeFor(successor),
      // Dossier is the related-context tray (a separate producer); an empty dossier is
      // honest — the drafters simply have no tracker items inlined this round.
      dossier: [],
      ...(review.successorAccount ? { successorAccount: review.successorAccount } : {}),
      ...(tree === undefined ? {} : { tree }),
    });
    // The lineage this round ACTUALLY has. A prior generation counts only if it was really
    // minted and persisted; otherwise this is a first generation and says so — no
    // synthesized predecessor for the ledger to drill into, and no phantom comparison set.
    const prior = await deps.priorGeneration(`gen:${input.priorPatchsetId}`);
    await deps.runRound({
      session: input.session,
      repoRoot: input.repoRoot,
      ...(prior === undefined
        ? {}
        : { previousGeneration: prior.generation, previous: prior.boards }),
      asksDispatched: [...input.asksDispatched],
      // The successor PATCHSET id keys the minted generation (not the post-turn HEAD oid),
      // so the generation the boards file under names the diff they actually read.
      runWorkers: async (): Promise<WorkerReturn> => ({
        commitRange: input.worked.commitRange,
        ...(landed ? { patchsetId: successor.id } : {}),
      }),
      onProgress: deps.emit,
      ...collation,
    });
  } catch (error) {
    deps.emit({ type: "failed", reason: error instanceof Error ? error.message : String(error) });
  }
}
