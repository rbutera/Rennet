import { sha256Hex } from "@rennet/protocol";
import type {
  ComposableAsk,
  ComposedHandoffBundle,
  ComposedTask,
  DispositionType,
  HandoffBundle,
  HandoffTask,
  RspTokenUsage,
} from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// Handoff-bundle composition (issue #72, Model Council job M24) — the light-tier
// AUTHORING step over the mechanical bundle (`buildHandoffBundle`, #18). It turns N
// terse anchored asks into ONE coherent work order: ordered for execution sense,
// overlapping asks merged, each group given a connective narrative.
//
// ⭐ THE SAFETY DESIGN, and why "merge must not lose an ask" holds STRUCTURALLY:
// the model is handed the asks WITH stable ids and asked to return ONLY a partition
// — an ordered list of groups, each citing ids and carrying a one-line title. It
// never returns bodies. The composer reconstructs every task's body VERBATIM from
// the trusted input by id. So the model chooses order + grouping + prose; it is
// structurally incapable of dropping or rewriting what was asked. A deterministic
// validator then rejects any partition that is not a total cover of the ids (a
// dropped id, a duplicated id, or an invented id), and on ANY doubt the composer
// falls back to the mechanical pass-through list (the always-present floor, R9).
//
// Pure and node-free like `handoff-loop.ts`: `@rennet/types` + the node-free
// `sha256Hex` only; the real council-routed model turn is injected as a `ComposePort`.
// ─────────────────────────────────────────────────────────────────────────────

/** A stable ask id: the ordinal in the mechanical bundle's deterministic order. */
function askIdAt(index: number): string {
  return `d${index}`;
}

/** Give every mechanical task its stable id (its deterministic ordinal). */
export function asksFromBundle(bundle: HandoffBundle): ComposableAsk[] {
  return bundle.tasks.map((task, index) => ({ ...task, id: askIdAt(index) }));
}

const TYPE_LABEL: Record<DispositionType, string> = {
  approve: "approval",
  "request-change": "requested change",
  comment: "comment",
  question: "question",
};

/** The human-facing anchor label ("lines A–B, additions" / "whole file"). */
function anchorLabel(task: HandoffTask): string {
  if (task.span === undefined) return "whole file";
  const end = task.span.endLine ?? task.span.startLine;
  const range =
    end === task.span.startLine
      ? `line ${task.span.startLine}`
      : `lines ${task.span.startLine}–${end}`;
  return task.side === undefined ? range : `${range}, ${task.side}`;
}

// ── The compose port (one injected model turn) ────────────────────────────────

/** The model's proposed partition: ordered groups, each citing ask ids + a title. */
export interface ComposeGroup {
  /** A one-line connective narrative for the group (model-authored prose). */
  readonly title: string;
  /** The ids of the asks this group merges — the composer supplies the bodies. */
  readonly dispositionIds: readonly string[];
}

export interface ComposeProposal {
  /** Groups in EXECUTION order (first group runs first). */
  readonly groups: readonly ComposeGroup[];
}

/** The outcome of the one model turn. A failure NEVER fabricates a proposal. */
export type ComposePortResult =
  | {
      readonly status: "emitted";
      readonly proposal: ComposeProposal;
      readonly usage?: RspTokenUsage;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/** The injected compose turn — the caller owns the harness (council-routed) wiring. */
export type ComposePort = (prompt: string) => Promise<ComposePortResult>;

/**
 * Build the compose prompt. It hands the model the asks WITH ids and constrains it
 * to return a partition only — order + grouping + a per-group title — never the ask
 * bodies. The instruction is explicit that every id must appear exactly once and no
 * id may be invented, so a well-behaved turn produces a total cover the validator
 * accepts; a mis-behaved one is caught and dropped rather than trusted.
 */
export function buildComposePrompt(asks: readonly ComposableAsk[]): string {
  const lines: string[] = [
    "You are composing a code reviewer's separate review notes into ONE coherent work order",
    "for a coding agent. You decide ONLY how to ORDER and GROUP them and write a short title",
    "for each group. You do NOT rewrite, summarise, or drop any note — the exact text is",
    "re-attached from the ids you cite.",
    "",
    "Rules, in order of importance:",
    "1. Every note id below must appear in EXACTLY ONE group. Never omit an id, never repeat an",
    "   id, never invent an id. If two notes are unrelated, put each in its own group.",
    "2. Merge notes into one group ONLY when they are the same change or must be done together",
    "   (same symbol, overlapping lines, or one depends on the other).",
    "3. Order the groups for EXECUTION sense: dependencies first, then changes to the same file",
    "   or nearby code adjacent, so the agent works top-to-bottom without thrashing.",
    "4. The title is one plain line naming what the group accomplishes. No marketing, no filler.",
    "",
    "The notes:",
  ];
  for (const ask of asks) {
    const body =
      ask.instruction.trim() === "" ? "(no text — infer from the anchor)" : ask.instruction.trim();
    lines.push(
      `- id ${ask.id} · ${TYPE_LABEL[ask.type]} · ${ask.path} (${anchorLabel(ask)}): ${body}`,
    );
  }
  lines.push(
    "",
    'Return JSON: {"groups":[{"title":"<one line>","dispositionIds":["<id>", ...]}, ...]}.',
    "The group order is the execution order.",
  );
  return lines.join("\n");
}

// ── Validation: the partition must be a TOTAL COVER of the ask ids ────────────

export type CompositionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate the model's partition against the asks: every ask id appears in exactly
 * one group, no id is repeated across or within groups, and no cited id is unknown.
 * This is the whole content-preservation guarantee's mechanical half — a valid
 * partition provably loses nothing, because the bodies are reconstructed from the
 * ids by the composer.
 */
export function validateComposition(
  asks: readonly ComposableAsk[],
  proposal: ComposeProposal,
): CompositionValidation {
  const known = new Set(asks.map((ask) => ask.id));
  const seen = new Set<string>();
  for (const group of proposal.groups) {
    if (group.dispositionIds.length === 0) {
      return { ok: false, reason: "a group cited no asks" };
    }
    for (const id of group.dispositionIds) {
      if (!known.has(id))
        return { ok: false, reason: `the composition cited an unknown ask id: ${id}` };
      if (seen.has(id))
        return { ok: false, reason: `the composition cited ask id ${id} more than once` };
      seen.add(id);
    }
  }
  if (seen.size !== known.size) {
    const missing = [...known].filter((id) => !seen.has(id));
    return {
      ok: false,
      reason: `the composition dropped ${missing.length} ask(s): ${missing.join(", ")}`,
    };
  }
  return { ok: true };
}

// ── Rendering + assembly ──────────────────────────────────────────────────────

/**
 * Render the coherent work-order prompt from the composed tasks. Each group leads
 * with its (model or empty) title, then lists its member asks VERBATIM with anchor
 * and context, so the coding agent reads one ordered narrative rather than N
 * disconnected comments — and every original instruction body is present unaltered.
 */
export function renderComposedPrompt(tasks: readonly ComposedTask[]): string {
  const askCount = tasks.reduce((total, task) => total + task.asks.length, 0);
  const out: string[] = [
    "# Review handoff",
    "",
    "You are a coding agent addressing a reviewer's requested changes on the current branch.",
    "Work through the tasks below IN ORDER, editing files in place.",
    "",
    "Rules, in order of importance:",
    "1. Address ONLY the tasks listed below. Do not make unrelated changes.",
    "2. Do NOT commit, do NOT push, do NOT run git. Just edit the files; the review harness",
    "   captures your result and re-reviews it.",
    "3. If a task cannot be done as asked, leave those files unchanged and say why in your final",
    "   message — never guess or half-apply it.",
    "",
    `## Tasks (${tasks.length} — ${askCount} review note${askCount === 1 ? "" : "s"})`,
  ];
  tasks.forEach((task, index) => {
    out.push(
      "",
      `### ${index + 1}. ${task.title.trim() === "" ? (task.asks[0]?.path ?? "task") : task.title.trim()}`,
    );
    for (const ask of task.asks) {
      out.push(
        "",
        `- ${TYPE_LABEL[ask.type]} — ${ask.path} (${anchorLabel(ask)}):`,
        ask.instruction.trim() === ""
          ? "  (no instruction body — infer from the context below)"
          : `  ${ask.instruction.trim()}`,
      );
      if (ask.context !== "") {
        out.push("", "  Anchored diff context:", "  ```diff", ask.context, "  ```");
      }
    }
  });
  return out.join("\n");
}

/** Digest over the ordered composed structure — binds a disclosure/consent to it. */
function composedDigest(tasks: readonly ComposedTask[]): string {
  return sha256Hex(
    JSON.stringify(
      tasks.map((task) => ({
        title: task.title,
        ids: [...task.sourceDispositions],
        asks: task.asks.map((ask) => ({
          id: ask.id,
          path: ask.path,
          type: ask.type,
          instruction: ask.instruction,
          span: ask.span ?? null,
          side: ask.side ?? null,
        })),
      })),
    ),
  );
}

function assemble(
  reviewId: string,
  patchsetId: string,
  tasks: readonly ComposedTask[],
  composed: boolean,
): ComposedHandoffBundle {
  const traceMap: Record<string, number> = {};
  tasks.forEach((task, index) => {
    for (const id of task.sourceDispositions) traceMap[id] = index;
  });
  return {
    reviewId,
    patchsetId,
    tasks,
    prompt: renderComposedPrompt(tasks),
    digest: composedDigest(tasks),
    composed,
    traceMap,
  };
}

/**
 * The mechanical FLOOR: one task per ask, in the mechanical order, no merging, no
 * title. Always valid, always complete — the fail-closed fallback the acceptance
 * names ("pass-through list form on any doubt").
 */
export function mechanicalComposition(
  bundle: HandoffBundle,
  asks: readonly ComposableAsk[] = asksFromBundle(bundle),
): ComposedHandoffBundle {
  const tasks: ComposedTask[] = asks.map((ask) => ({
    title: "",
    sourceDispositions: [ask.id],
    asks: [ask],
  }));
  return assemble(bundle.reviewId, bundle.patchsetId, tasks, false);
}

/**
 * Compose the bundle via the injected model port, with the deterministic floor as
 * the fallback. Runs one turn; on unavailable/failed OR an invalid partition, returns
 * the mechanical pass-through (never a lossy authoring). On a VALID partition, builds
 * the composed tasks in the model's group order with bodies reconstructed verbatim
 * from the input — then belt-and-braces asserts every original body survived into the
 * rendered prompt, falling back if (impossibly) one did not.
 */
export async function composeHandoffBundle(
  bundle: HandoffBundle,
  port: ComposePort,
): Promise<ComposedHandoffBundle> {
  const asks = asksFromBundle(bundle);
  if (asks.length === 0) return mechanicalComposition(bundle, asks);

  const turn = await port(buildComposePrompt(asks));
  if (turn.status !== "emitted") return mechanicalComposition(bundle, asks);

  const validation = validateComposition(asks, turn.proposal);
  if (!validation.ok) return mechanicalComposition(bundle, asks);

  const byId = new Map(asks.map((ask) => [ask.id, ask] as const));
  const tasks: ComposedTask[] = turn.proposal.groups.map((group) => ({
    title: group.title,
    sourceDispositions: [...group.dispositionIds],
    // Reconstruct bodies from the TRUSTED input — the model supplied only ids.
    asks: group.dispositionIds.map((id) => {
      const ask = byId.get(id);
      if (!ask) throw new Error("unreachable: validated id missing from ask map");
      return ask;
    }),
  }));

  const composed = assemble(bundle.reviewId, bundle.patchsetId, tasks, true);
  // Content-preservation guard: every original instruction body must be present in
  // the rendered work order. Reconstruction guarantees it, but assert it rather than
  // trust it — a mismatch means fall closed to the mechanical floor.
  for (const ask of asks) {
    const body = ask.instruction.trim();
    if (body !== "" && !composed.prompt.includes(body)) {
      return mechanicalComposition(bundle, asks);
    }
  }
  return composed;
}
