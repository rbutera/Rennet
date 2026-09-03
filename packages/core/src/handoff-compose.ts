import type {
  ComposableAsk,
  ComposedHandoffBundle,
  ComposedTask,
  DispositionType,
  HandoffBundle,
  HandoffTask,
  RspTokenUsage,
} from "@rennet/protocol";
import { sha256Hex } from "@rennet/protocol";
import { type SessionContextFile, sessionContextRelativeDir } from "./session-context";

/**
 * The one rule both handoff prompts share verbatim: the coding agent edits, the
 * review harness captures. Shared so the two prompts cannot drift on it (#737).
 */
export const HANDOFF_NO_GIT_RULE = [
  "2. Do NOT commit, do NOT push, do NOT run git. Just edit the files; the review harness",
  "   captures your result and re-reviews it.",
] as const;

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
// the trusted input by id. So the model chooses order + grouping only; it is
// structurally incapable of dropping or rewriting what was asked. A deterministic
// validator then rejects any partition that is not a total cover of the ids (a
// dropped id, a duplicated id, or an invented id), and on ANY doubt the composer
// falls back to the mechanical pass-through list (the always-present floor, R9).
//
// ⭐ And NO model-authored prose reaches the executable prompt (F1): the group title
// is PREVIEW-ONLY metadata (for the human's paper), while the coding agent's work
// order is built from the human's verbatim bodies plus headings derived MECHANICALLY
// from the trusted ask paths. So a partition that validates cannot smuggle an invented
// instruction in through a title field — the executable contract can only ever carry
// the reviewer's asks and facts derived from them. This is NOT a consent gate: nothing
// is confirmed or withheld; the prompt simply contains the asks and nothing invented.
//
// Pure and node-free like `handoff-loop.ts`: `@rennet/protocol` + the node-free
// `sha256Hex` only; the real council-routed model turn is injected as a `ComposePort`.
// ─────────────────────────────────────────────────────────────────────────────

/** Preserve the durable ask identity already carried by each mechanical task. */
export function asksFromBundle(bundle: HandoffBundle): ComposableAsk[] {
  return bundle.tasks.map((task) => ({ ...task }));
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
 * The reviewer's notes as ONE file (design D4) — id, kind, anchor and the body VERBATIM.
 * The compose turn reads it and answers with a partition over the ids; the bodies never
 * travel in the prompt, in either direction.
 */
export function composeAsksContextFile(asks: readonly ComposableAsk[]): SessionContextFile {
  return {
    name: "compose/asks.json",
    body: JSON.stringify(
      asks.map((ask) => ({
        id: ask.id,
        kind: TYPE_LABEL[ask.type],
        path: ask.path,
        anchor: anchorLabel(ask),
        note: ask.instruction.trim(),
      })),
    ),
    holds:
      "Every review note the reviewer staged: its `id`, its kind, the file and anchor it sits on, and the note text verbatim.",
    readWhen: "always — you are ordering and grouping exactly these ids.",
  };
}

/**
 * Build the compose prompt. It points the model at the asks WITH their ids and constrains
 * it to return a partition only — order + grouping + a per-group title — never the ask
 * bodies. The instruction is explicit that every id must appear exactly once and no
 * id may be invented, so a well-behaved turn produces a total cover the validator
 * accepts; a mis-behaved one is caught and dropped rather than trusted.
 *
 * The notes are NOT in this prompt: they are `compose/asks.json`, named by relative path.
 */
export function buildComposePrompt(sessionId: string): string {
  const dir = sessionContextRelativeDir(sessionId);
  return [
    "You are composing a code reviewer's separate review notes into ONE coherent work order",
    "for a coding agent. You decide ONLY how to ORDER and GROUP them and write a short title",
    "for each group. You do NOT rewrite, summarise, or drop any note — the exact text is",
    "re-attached from the ids you cite.",
    "",
    `Read the notes from \`${dir}/compose/asks.json\` in your working directory. Each entry`,
    "carries an `id`, its kind, the `path` and `anchor` it sits on, and the `note` itself.",
    "",
    "Rules, in order of importance:",
    "1. Every note id in that file must appear in EXACTLY ONE group. Never omit an id, never",
    "   repeat an id, never invent an id. If two notes are unrelated, put each in its own group.",
    "2. Merge notes into one group ONLY when they are the same change or must be done together",
    "   (same symbol, overlapping lines, or one depends on the other).",
    "3. Order the groups for EXECUTION sense: dependencies first, then changes to the same file",
    "   or nearby code adjacent, so the agent works top-to-bottom without thrashing.",
    "4. The title is one plain line naming what the group accomplishes. No marketing, no filler.",
    "",
    'Return JSON: {"groups":[{"title":"<one line>","dispositionIds":["<id>", ...]}, ...]}.',
    "The group order is the execution order.",
  ].join("\n");
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
  if (known.size !== asks.length) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const ask of asks) {
      if (seen.has(ask.id)) duplicates.add(ask.id);
      seen.add(ask.id);
    }
    return {
      ok: false,
      reason: `the input contained duplicate ask id(s): ${[...duplicates].join(", ")}`,
    };
  }
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
 * A group's executable heading, derived MECHANICALLY from the trusted asks — the
 * distinct file paths it touches, in order. The model's `title` is NOT used here:
 * it is preview metadata (shown to the human on the paper) and never reaches the
 * prompt the coding agent executes. This is the structural half of F1's fix — the
 * executable contract can carry only the human's asks + facts derived from them, so
 * a model-authored line cannot inject an instruction the reviewer never wrote.
 */
function mechanicalHeading(task: ComposedTask): string {
  const paths: string[] = [];
  for (const ask of task.asks) {
    if (!paths.includes(ask.path)) paths.push(ask.path);
  }
  return paths.length === 0 ? "task" : paths.join(", ");
}

/** The one name the executable work order is written and read under, per session. */
export const WORK_ORDER_FILE = "work-order.md";

/**
 * Render the coherent work-order DOCUMENT from the composed tasks. Each group leads
 * with a heading DERIVED MECHANICALLY from its asks' paths (never the model's title),
 * then lists its member asks with anchor, the instruction body VERBATIM, and context,
 * so the coding agent reads one ordered narrative rather than N disconnected comments
 * — and every original instruction body is present, byte-for-byte unaltered. No
 * model-authored prose enters it: the title stays preview-only.
 *
 * This is the FILE, not the prompt (session-context-files). It is written to
 * `.rennet/context/<sessionId>/work-order.md` before the run and the turn's prompt names
 * that path — so the asks and their diff fences reach the agent by being read, not by
 * being billed on every retry.
 */
export function renderWorkOrder(tasks: readonly ComposedTask[]): string {
  const askCount = tasks.reduce((total, task) => total + task.asks.length, 0);
  const out: string[] = [
    "# Review handoff",
    "",
    "You are a coding agent addressing a reviewer's requested changes on the current branch.",
    "Work through the tasks below IN ORDER, editing files in place.",
    "",
    "Rules, in order of importance:",
    "1. Address ONLY the tasks listed below. Do not make unrelated changes.",
    ...HANDOFF_NO_GIT_RULE,
    "3. If a task cannot be done as asked, leave those files unchanged and say why in your final",
    "   message — never guess or half-apply it.",
    "",
    `## Tasks (${tasks.length} — ${askCount} review note${askCount === 1 ? "" : "s"})`,
  ];
  tasks.forEach((task, index) => {
    out.push("", `### ${index + 1}. ${mechanicalHeading(task)}`);
    for (const ask of task.asks) {
      out.push("", `- ${TYPE_LABEL[ask.type]} — ${ask.path} (${anchorLabel(ask)}):`);
      // The instruction body VERBATIM (F2): trim only to DETECT an empty body; when it
      // is non-empty, append `ask.instruction` UNCHANGED so indentation, code blocks
      // and Markdown semantics survive exactly as the reviewer wrote them.
      out.push(
        ask.instruction.trim() === ""
          ? "  (no instruction body — infer from the context below)"
          : ask.instruction,
      );
      if (ask.context !== "") {
        out.push("", "  Anchored diff context:", "  ```diff", ask.context, "  ```");
      }
    }
  });
  return out.join("\n");
}

/** The work order as the file the run writes and the turn is pointed at. */
export function workOrderContextFile(tasks: readonly ComposedTask[]): SessionContextFile {
  return {
    name: WORK_ORDER_FILE,
    body: renderWorkOrder(tasks),
    holds:
      "The reviewer's requested changes as one ordered work order: each task's file, anchor, the note verbatim, and the anchored diff context.",
    readWhen: "first, and in full — it is the work you were started to do.",
  };
}

/**
 * The prompt the coding turn actually receives: the rules, the shape of the job, and the
 * PATH of the work order. The asks and their diff fences are in the file, not here.
 *
 * Deterministic in `tasks` and the session id, so `verifyComposedBundle` can recompute it
 * and prove the run is executing the order that was composed.
 */
export function renderComposedPrompt(tasks: readonly ComposedTask[], sessionId: string): string {
  const askCount = tasks.reduce((total, task) => total + task.asks.length, 0);
  return [
    "# Review handoff",
    "",
    "You are a coding agent addressing a reviewer's requested changes on the current branch.",
    "",
    `Your work order is \`${sessionContextRelativeDir(sessionId)}/${WORK_ORDER_FILE}\`, in your`,
    `working directory. It holds ${tasks.length} task${tasks.length === 1 ? "" : "s"} carrying`,
    `${askCount} review note${askCount === 1 ? "" : "s"}, in execution order, each with the`,
    "reviewer's note verbatim and the anchored diff context. Read it in full, then work",
    "through the tasks IN ORDER, editing files in place.",
    "",
    "Rules, in order of importance:",
    "1. Address ONLY the tasks in that file. Do not make unrelated changes.",
    ...HANDOFF_NO_GIT_RULE,
    "3. If a task cannot be done as asked, leave those files unchanged and say why in your final",
    "   message — never guess or half-apply it.",
  ].join("\n");
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
          finding: ask.finding ?? null,
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
    // Strip the array-level readonly: the mutable z.infer bundle field wants ComposedTask[].
    tasks: [...tasks],
    // The turn's prompt, which NAMES the work order; the work order itself is the file
    // `workOrderContextFile` writes. `reviewId` is the session the context directory is
    // keyed on — the same key `t3/handoff.ts` binds the review's thread under.
    prompt: renderComposedPrompt(tasks, reviewId),
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

  // F3: a compose port that REJECTS (throws) rather than resolving to a `failed`
  // result must not escape as a rejected IPC command — the floor is the fail-closed
  // contract. Catch the rejection at the composition boundary and return the floor.
  // F3: a compose port that REJECTS (throws) rather than resolving to a `failed`
  // result must not escape as a rejected IPC command — the floor is the fail-closed
  // contract. Catch the rejection at the composition boundary and return the floor.
  let turn: ComposePortResult;
  try {
    turn = await port(buildComposePrompt(bundle.reviewId));
  } catch {
    return mechanicalComposition(bundle, asks);
  }
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
  // the rendered work order VERBATIM. Reconstruction guarantees it, but assert it
  // rather than trust it — a mismatch means fall closed to the mechanical floor. The
  // guard reads the WORK ORDER, which is where the bodies now live; the bundle's prompt
  // only names the file.
  const workOrder = renderWorkOrder(composed.tasks);
  for (const ask of asks) {
    if (ask.instruction.trim() === "") continue;
    if (!workOrder.includes(ask.instruction)) {
      return mechanicalComposition(bundle, asks);
    }
  }
  return composed;
}

/**
 * The compose→run integrity check (issue #72). The run boundary executes the bundle
 * that `composeHandoffBundle` produced, and this proves — by recomputation — that the
 * bundle handed to the run is the SAME bytes that were composed: its `digest` is the
 * genuine digest of its `tasks`, and its executable `prompt` is the faithful render of
 * those tasks. A bundle whose prompt or a task body was swapped after composition
 * (digest or prompt no longer matches the tasks) fails this check, so the run refuses
 * it rather than executing an order nobody composed. This is INTEGRITY, not a consent
 * gate: the mechanical floor (`composed:false`) passes exactly like a `composed:true`
 * bundle, because both are reconstructed the same deterministic way.
 */
export function verifyComposedBundle(bundle: ComposedHandoffBundle): boolean {
  return (
    composedDigest(bundle.tasks) === bundle.digest &&
    renderComposedPrompt(bundle.tasks, bundle.reviewId) === bundle.prompt
  );
}
