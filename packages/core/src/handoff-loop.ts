import { sha256Hex } from "@rennet/protocol";
import type {
  AnchorSide,
  AnchorSpan,
  Disposition,
  DispositionType,
  HandoffBundle,
  HandoffDisclosure,
  HandoffDisposition,
  HandoffTask,
  PatchFile,
  Patchset,
  RspTokenUsage,
} from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// The review→agent handoff loop (issue #18, Contracts §2.1 destination B — "your
// own branch"). This module is the PURE half: the deterministic bundle composer,
// the spend disclosure, and the turn orchestrator over injected ports. It imports
// only `@rennet/types` + the node-free `sha256Hex` from `@rennet/protocol`, so it
// stays node-free and testable with fakes — the real `claude` write session and
// the real git checkpoint store are composed by `apps/desktop`/`@rennet/adapters`
// and passed in.
//
// What is NEW here vs. what is reused:
//   • NEW: bundle composition (dispositions → a task-bundle prompt with anchors
//     resolved to concrete diff context), the spend disclosure, and the turn
//     bracket (pre-checkpoint → write turn → post-checkpoint → turn diff).
//   • REUSED (by the caller, not here): the new patchset is captured by the same
//     `ReviewService.capture`/`PatchsetActivated` fold every re-capture uses, so
//     the prior patchset stays byte-identical (R28) and the byte-identical floor
//     carry (`carryDispositions`) runs — the delta re-review's conservative floor.
//   • SEAM (#16): `LineageCarryPort` upgrades that floor to carry approvals through
//     moves/splits; explicitly UNIMPLEMENTED here (never a fabricated carry).
//
// ⛔ Safety properties do NOT relax inside the loop (§2.1): the human still
// disposes; the agent addresses dispositions and nothing else; Rennet never pushes
// (the write session denies exec, so `git push` is unreachable — enforced by the
// caller's tool policy); a new patchset never rewrites the active one (R28).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The disposition types a coding agent can act on. `request-change` and `comment`
 * are addressed (both ask for or suggest a code change). `approve` means "leave it"
 * and `question` is answered in conversation, not by editing code — both are
 * excluded, so the agent is never handed a task it cannot honestly complete by
 * editing files. This is the §2.1 "the agent addresses dispositions and nothing
 * else" filter, made explicit.
 */
export const HANDOFF_ADDRESSED_TYPES: readonly DispositionType[] = ["request-change", "comment"];

/** Whether a disposition type is one the handoff agent addresses. */
export function isAddressedByHandoff(type: DispositionType): boolean {
  return HANDOFF_ADDRESSED_TYPES.includes(type);
}

/** How much of a task's anchored diff context is inlined (bounds the prompt size). */
export const HANDOFF_CONTEXT_CEILING = 8_000;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Bound a section to `maxBytes`, marking the cut honestly. "" stays "". */
function boundToBytes(section: string, maxBytes: number): string {
  if (section.length <= maxBytes) return section;
  return `${section.slice(0, maxBytes)}\n… (context truncated at ${maxBytes} bytes)`;
}

/**
 * The single hunk of `file.patch` whose line range contains the anchored span,
 * plus the file's header lines. `side === "deletions"` matches the old-file range
 * (`-oldStart,oldLen`); otherwise the new-file range (`+newStart,newLen`). `null`
 * when no hunk covers the span — the caller then falls back to the whole patch.
 */
function hunkForSpan(patch: string, span: AnchorSpan, side?: AnchorSide): string | null {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => HUNK_HEADER.test(line));
  if (firstHunk === -1) return null;
  const header = lines.slice(0, firstHunk);
  const useOld = side === "deletions";
  for (let index = firstHunk; index < lines.length; index += 1) {
    const match = lines[index]?.match(HUNK_HEADER);
    if (!match) continue;
    const start = Number(useOld ? match[1] : match[3]);
    const length = Number((useOld ? match[2] : match[4]) ?? "1");
    const end = start + Math.max(length, 1) - 1;
    if (span.startLine >= start && span.startLine <= end) {
      let next = index + 1;
      while (next < lines.length && !HUNK_HEADER.test(lines[next] ?? "")) next += 1;
      return [...header, ...lines.slice(index, next)].join("\n");
    }
  }
  return null;
}

/**
 * The diff context a disposition refers to, bounded. With a span, the covering
 * hunk (so a note anchored past the byte ceiling still gets its own code, not an
 * unrelated truncation from the file's start). Without a span, the whole file
 * patch, bounded. "" when the file is not in the active patchset (the agent works
 * from the instruction alone — still an honest task, never a guessed context).
 */
export function anchoredContext(
  file: PatchFile | undefined,
  maxBytes: number,
  span?: AnchorSpan,
  side?: AnchorSide,
): string {
  if (!file) return "";
  if (span === undefined) return boundToBytes(file.patch, maxBytes);
  return boundToBytes(hunkForSpan(file.patch, span, side) ?? file.patch, maxBytes);
}

/** Stable order for the tasks: by path, then by span start, then by type — so the
 *  same set of dispositions always composes the same bundle (a stable digest the
 *  consent token can bind to). */
function compareTasks(left: HandoffDisposition, right: HandoffDisposition): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  const leftStart = left.span?.startLine ?? 0;
  const rightStart = right.span?.startLine ?? 0;
  if (leftStart !== rightStart) return leftStart - rightStart;
  return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
}

const TYPE_LABEL: Record<DispositionType, string> = {
  approve: "approval",
  "request-change": "requested change",
  comment: "comment",
  question: "question",
};

/** The human-facing anchor label for one task ("lines A–B, additions" / "whole file"). */
function anchorLabel(task: HandoffTask): string {
  if (task.span === undefined) return "whole file";
  const end = task.span.endLine ?? task.span.startLine;
  const range =
    end === task.span.startLine
      ? `line ${task.span.startLine}`
      : `lines ${task.span.startLine}–${end}`;
  return task.side === undefined ? range : `${range}, ${task.side}`;
}

/**
 * Render the deterministic bundle prompt — the task-bundle CONTRACT. It enumerates
 * every addressed task with its anchor and diff context and instructs the agent to
 * address ONLY these items, editing files in place, never committing or pushing.
 * Deterministic in the ordered tasks, so the same bundle always renders the same
 * prompt (and hence the same digest the consent token binds to).
 */
export function renderHandoffPrompt(tasks: readonly HandoffTask[]): string {
  const out: string[] = [
    "# Review handoff",
    "",
    "You are a coding agent addressing a reviewer's dispositions on the current branch.",
    "Make exactly the changes requested below, editing files in place.",
    "",
    "Rules, in order of importance:",
    "1. Address ONLY the items listed below. Do not make unrelated changes, do not refactor",
    "   beyond what is asked, do not reformat untouched code.",
    "2. Do NOT commit, do NOT push, do NOT run git. Just edit the files; the review harness",
    "   captures your result and re-reviews it.",
    "3. If an item cannot be done as asked, leave that file unchanged and say why in your",
    "   final message — never guess or half-apply it.",
    "",
    `## Requested changes (${tasks.length})`,
  ];
  tasks.forEach((task, index) => {
    out.push(
      "",
      `### ${index + 1}. ${TYPE_LABEL[task.type]} — ${task.path} (${anchorLabel(task)})`,
      "",
      task.instruction.trim() === ""
        ? "(no instruction body — infer from the context below)"
        : task.instruction.trim(),
    );
    if (task.context !== "") {
      out.push("", "Anchored diff context:", "```diff", task.context, "```");
    }
  });
  return out.join("\n");
}

/** Input to the bundle composer. `dispositions` are already the effective bodies
 *  the renderer staged (refined-if-kept, else raw), mirroring how `publish.review`
 *  receives the previewed `comments`. */
export interface BuildHandoffBundleInput {
  readonly reviewId: string;
  readonly patchset: Patchset;
  readonly dispositions: readonly HandoffDisposition[];
}

/**
 * Compose the task bundle from the addressed dispositions and the active patchset.
 * Pure and deterministic: filters to the addressed types, resolves each anchor to
 * its bounded diff context, orders the tasks stably, renders the prompt, and stamps
 * a content digest over the ordered tasks. The digest binds the spend disclosure and
 * the consent token to THIS exact bundle, so a run cannot execute a bundle the user
 * never saw.
 */
export function buildHandoffBundle(input: BuildHandoffBundleInput): HandoffBundle {
  const fileByPath = new Map(input.patchset.files.map((file) => [file.path, file] as const));
  const addressed = input.dispositions
    .filter((disposition) => isAddressedByHandoff(disposition.type))
    .slice()
    .sort(compareTasks);
  const tasks: HandoffTask[] = addressed.map((disposition) => ({
    path: disposition.path,
    type: disposition.type,
    instruction: disposition.body,
    ...(disposition.span === undefined ? {} : { span: disposition.span }),
    ...(disposition.side === undefined ? {} : { side: disposition.side }),
    context: anchoredContext(
      fileByPath.get(disposition.path),
      HANDOFF_CONTEXT_CEILING,
      disposition.span,
      disposition.side,
    ),
  }));
  const prompt = renderHandoffPrompt(tasks);
  const digest = sha256Hex(
    JSON.stringify(
      tasks.map((task) => ({
        path: task.path,
        type: task.type,
        instruction: task.instruction,
        span: task.span ?? null,
        side: task.side ?? null,
      })),
    ),
  );
  return { reviewId: input.reviewId, patchsetId: input.patchset.id, tasks, prompt, digest };
}

/**
 * The spend disclosure surfaced BEFORE the write session (issue #18). Names the
 * harness, its model (when known), the task count, and the two things the user is
 * consenting to: a model spend AND an in-place edit of the working tree.
 */
export function disclosureFor(
  bundle: HandoffBundle,
  harness: string,
  model?: string,
): HandoffDisclosure {
  const summary =
    bundle.tasks.length === 0
      ? `Hand off 0 changes to ${harness} — nothing to do.`
      : `Hand off ${bundle.tasks.length} requested change${bundle.tasks.length === 1 ? "" : "s"} to ${harness}${
          model ? ` (${model})` : ""
        }. It will edit your working tree; Rennet re-reviews the result. Nothing is committed or pushed.`;
  return {
    harness,
    ...(model === undefined ? {} : { model }),
    taskCount: bundle.tasks.length,
    writeEnabled: true,
    editsWorkingTree: true,
    summary,
  };
}

// ── The write-enabled run port ────────────────────────────────────────────────

/** The input to one write-enabled agent turn. */
export interface HandoffRunInput {
  /** The repository root — the write session's working directory. */
  readonly cwd: string;
  /** The bundle prompt — the task contract. */
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

/** The outcome of one write-enabled turn. A `failed` turn NEVER fabricates success. */
export type HandoffRunOutcome =
  | { readonly status: "completed"; readonly finalText: string; readonly usage?: RspTokenUsage }
  | { readonly status: "failed"; readonly reason: string };

/**
 * The injected write-enabled turn. The caller owns the harness wiring (the real
 * `claude` adapter with `readOnly:false` and an exec-DENIED tool policy so `git
 * push` is unreachable; or a fake in tests), keeping this module pure.
 */
export type HandoffRunPort = (input: HandoffRunInput) => Promise<HandoffRunOutcome>;

// ── The checkpoint bracket ────────────────────────────────────────────────────

/** One workspace checkpoint reference (an opaque commit-ish the port understands). */
export interface CheckpointRef {
  readonly ref: string;
  readonly commit: string;
}

/**
 * The injected checkpoint store (the real one writes hidden git refs; T3 Code's
 * pattern, vendored in `@rennet/adapters`). `capture` snapshots the working tree
 * (tracked + untracked) without touching HEAD/index/branch/reflog; `diff` renders
 * the change between two checkpoints (the turn diff).
 */
export interface CheckpointPort {
  capture(): Promise<CheckpointRef>;
  diff(from: CheckpointRef, to: CheckpointRef): Promise<string>;
}

/** The `diff --git a/… b/…` file headers → the changed paths (post-image side). */
export function filesTouchedByDiff(unifiedDiff: string): string[] {
  const paths = new Set<string>();
  for (const line of unifiedDiff.split("\n")) {
    const match = line.match(/^diff --git a\/(?:.+) b\/(.+)$/);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return [...paths].sort();
}

/** The result of the bracketed write turn (before the new patchset is captured). */
export type HandoffTurnOutcome =
  | {
      readonly status: "completed";
      readonly finalText: string;
      readonly turnDiff: string;
      readonly filesTouched: readonly string[];
      readonly usage?: RspTokenUsage;
    }
  | { readonly status: "failed"; readonly reason: string };

export interface RunHandoffTurnInput {
  readonly repoRoot: string;
  readonly bundle: HandoffBundle;
  readonly runPort: HandoffRunPort;
  readonly checkpoint: CheckpointPort;
  readonly signal?: AbortSignal;
}

/**
 * Bracket the agent's write turn with workspace checkpoints and extract the turn
 * diff (issue #18, the T3 Code mechanism). Pre-checkpoint → run the write-enabled
 * turn → post-checkpoint → diff. The turn diff isolates exactly what THIS turn
 * changed (distinct from any pre-existing uncommitted work), and `filesTouched`
 * carries every path it changed — including edits unrelated to any disposition, so
 * the totality guarantee is measurable at the source. A failed turn returns the
 * honest failure; it never captures a patchset from a turn that did not complete.
 */
export async function runHandoffTurn(input: RunHandoffTurnInput): Promise<HandoffTurnOutcome> {
  const before = await input.checkpoint.capture();
  const outcome = await input.runPort({
    cwd: input.repoRoot,
    prompt: input.bundle.prompt,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (outcome.status === "failed") return { status: "failed", reason: outcome.reason };
  const after = await input.checkpoint.capture();
  const turnDiff = await input.checkpoint.diff(before, after);
  return {
    status: "completed",
    finalText: outcome.finalText,
    turnDiff,
    filesTouched: filesTouchedByDiff(turnDiff),
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  };
}

// ── The #16 lineage-carry seam (explicitly UNIMPLEMENTED) ─────────────────────

/**
 * The delta re-review carries approvals forward. The BYTE-IDENTICAL FLOOR already
 * runs inside `foldReview(PatchsetActivated)` (`carryDispositions`): a disposition
 * on a file unchanged since the reviewer read it stays. Moved / renamed / split code
 * fails closed and is re-reviewed. Totality still holds — the new patchset captures
 * the WHOLE working-tree diff, so every changed file appears.
 *
 * #16's calibrated lineage matcher UPGRADES that floor to carry approvals through
 * moves. This is the typed boundary it drops into: given the prior dispositions and
 * the two patchsets, return the EXTRA dispositions to carry (re-anchored onto the
 * successor) where lineage is exact/one-to-one/move and NOT ambiguous (ambiguity
 * fails closed, R8/§3.3). It is deliberately NOT stubbed with a plausible return —
 * `notWiredLineageCarry` reports `matcher-not-wired` so the loop runs the real floor
 * carry and the delta stays honest and complete, just conservative, until #16 lands.
 */
export interface LineageCarryInput {
  readonly previous: readonly Disposition[];
  readonly previousPatchset: Patchset;
  readonly nextPatchset: Patchset;
}

export type LineageCarryResult =
  | { readonly status: "matcher-not-wired" }
  | { readonly status: "applied"; readonly carried: readonly Disposition[] };

export interface LineageCarryPort {
  carry(input: LineageCarryInput): Promise<LineageCarryResult>;
}

/** The sentinel returned while #16 is not wired. */
export const LINEAGE_MATCHER_NOT_WIRED = "matcher-not-wired" as const;

/**
 * The not-wired lineage carry: reports the seam is unwired rather than fabricating a
 * carry. The delta re-review then relies on the byte-identical floor (real) alone.
 */
export function notWiredLineageCarry(): LineageCarryPort {
  return { carry: () => Promise.resolve({ status: LINEAGE_MATCHER_NOT_WIRED }) };
}
