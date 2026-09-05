import {
  type CodexExecutor,
  type CouncilOverrideReader,
  councilContextFor,
  draftPrBody,
  type HarnessPort,
  type PrBodyDraftInput,
  type PrBodyDraftPort,
  type PrBodyDraftPortResult,
  prBodyContextFiles,
  providerHarness,
  resolveAssignment,
} from "@rennet/core";
import type { PromptContextFile } from "@rennet/prompts";
import type {
  CouncilHarnessId,
  DispositionType,
  PrBodyDraftResult,
  Review,
} from "@rennet/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// review.draftPrBody — the LIVE producer (issue #74, M26).
//
// The structural sibling of `refine-comment-live.ts`: `packages/core`'s
// `draftPrBody` router owns the whole mapping law (emitted → drafted, the
// empty-title-or-body honesty floor) and is unit-proven; this module supplies the
// ONE real turn behind it. Council-routed: `resolveAssignment` picks the model +
// effort for the `pr-body-draft` job (the previously-dead catalogue row #7 goes
// live HERE), and the turn runs on WHICHEVER harness the council resolves.
//
// BOTH seats are live, exactly as the refine producer:
//   • Codex — one `codex exec` constrained to the inline `{title, body}` schema.
//     The council's PR-body-draft assignment whenever Codex is installed (Luna).
//   • Claude — one light read-only adapter session with the SAME inline schema
//     passed straight to the SDK's `json_schema` output format — the exact
//     structured-output mechanism every pipeline lens seat uses, needing NO
//     `pr-body-draft` RSP docType. It carries a Claude-only machine (Haiku there).
//
// A draft only degrades to an honest `unavailable` when NEITHER seat is installed.
// A failed/unavailable turn NEVER fabricates a draft — the renderer keeps the
// deterministic composed body, never a blank the human might sign unread. This
// producer posts NOTHING: it returns text into a preview (R33).
//
// Electron-free by construction (injected functions as values), so it is
// unit-testable with fakes — no Electron, no real `codex`, no real `claude`.
// ─────────────────────────────────────────────────────────────────────────────

/** The council job id for PR-body drafting (light tier, §2.3 M26, catalogue row 7). */
const PR_BODY_DRAFT_JOB_ID = "pr-body-draft";

/**
 * The tiny structured-output schema the drafting turn is constrained to. `title`
 * is the PR title; `body` is the Markdown description. Both are optional here — the
 * Codex executor's `sanitizeSchemaForCodex` makes them strict-safe (required +
 * nullable) for OpenAI structured outputs, and a null/absent field maps to the core
 * producer's honesty floor (an empty title or body is a failure, never a blank
 * preview).
 */
export const PR_BODY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "The PR title: one concise imperative line, no trailing period.",
    },
    body: {
      type: "string",
      description:
        "The PR description in Markdown: an honest account of the change, not a diffstat.",
    },
  },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

/** Render a thrown value into a turn-failure message (mirrors harness-run-turn). */
function describeThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "an uncoercible non-Error value";
  }
}

/**
 * Map a model's structured output to a `PrBodyDraftPortResult` — shared by both
 * seats, so Codex and Claude produce byte-identical results for the core router. A
 * title/body that is not a string rides through as absent, and the core router
 * enforces the empty-field honesty floor over it (never a fabricated draft).
 */
function mapDraftOutput(output: unknown): PrBodyDraftPortResult {
  const record = output as { title?: unknown; body?: unknown } | null;
  const title = typeof record?.title === "string" ? record.title : undefined;
  const body = typeof record?.body === "string" ? record.body : undefined;
  return {
    status: "emitted",
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
  };
}

/**
 * Build a `PrBodyDraftPort` over a Codex executor bound to the council-resolved
 * model + effort. One `codex exec` per draft, constrained to `PR_BODY_OUTPUT_SCHEMA`.
 * A non-zero exit / no-output / non-JSON throws INSIDE the executor; we catch it and
 * return the honest `failed` outcome the core router passes straight through — the
 * preview keeps its deterministic body, never a fabricated draft.
 */
export function codexDraftPrBodyPort(
  executor: CodexExecutor,
  model: string,
  effort: string,
  cwd: string,
): PrBodyDraftPort {
  return async (prompt) => {
    try {
      const result = await executor({
        model,
        effort,
        prompt,
        cwd,
        outputSchema: PR_BODY_OUTPUT_SCHEMA,
        label: "draft-pr-body",
      });
      const mapped = mapDraftOutput(result.output);
      // Report the model Codex OBSERVABLY ran (from its session log, #74 MED-3), not
      // the requested/planned `model`. Codex honors `-m`, so the two usually agree —
      // but a subscription that silently substitutes a model would make the requested
      // pick a lie about what wrote the draft, and the core must not render config as
      // runtime provenance. When the log named no model, `result.model` is absent and
      // the core falls back to the requested model (the best remaining truth).
      return mapped.status === "emitted" && result.model !== undefined
        ? { ...mapped, model: result.model }
        : mapped;
    } catch (error) {
      return { status: "failed", reason: `the PR-body draft turn failed: ${describeThrow(error)}` };
    }
  };
}

/**
 * Build a `PrBodyDraftPort` over the Claude harness adapter. One light READ-ONLY
 * session per draft, with `PR_BODY_OUTPUT_SCHEMA` passed straight to the SDK's
 * `json_schema` output format — the SAME structured-output mechanism every pipeline
 * lens seat uses, so no `pr-body-draft` docType is needed. The drain mirrors
 * `claudeRefinePort`: a completed turn with structured output emits; everything else
 * (a construction throw, an error frame, a failed/cancelled outcome, no structured
 * output) is an honest turn failure. The session is always closed. `cwd` is the
 * reviewed repo root; the session never writes or execs.
 */
export function claudeDraftPrBodyPort(port: HarnessPort, cwd: string): PrBodyDraftPort {
  return async (prompt) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd,
        outputSchema: PR_BODY_OUTPUT_SCHEMA,
        ephemeral: true,
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `the PR-body draft session failed to start: ${describeThrow(error)}`,
      };
    }
    try {
      await session.send({ prompt });
      // The model the harness ACTUALLY started on — reported so provenance records
      // what wrote the draft, not the council's planned pick (a Claude seat runs its
      // own default model, so claiming the resolved model would be a provenance lie).
      let actualModel: string | undefined;
      for await (const event of session.events) {
        if (event.kind === "session.started") actualModel = event.model;
        if (event.kind === "error") return { status: "failed", reason: event.error.message };
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return {
                status: "failed",
                reason: "the PR-body draft turn produced no structured output",
              };
            }
            const mapped = mapDraftOutput(outcome.structuredOutput);
            return mapped.status === "emitted" && actualModel !== undefined
              ? { ...mapped, model: actualModel }
              : mapped;
          }
          if (outcome.status === "failed")
            return { status: "failed", reason: outcome.error.message };
          return { status: "failed", reason: "the PR-body draft turn was cancelled" };
        }
      }
      return { status: "failed", reason: "the PR-body draft turn ended without a terminal frame" };
    } catch (error) {
      return { status: "failed", reason: `the PR-body draft turn threw: ${describeThrow(error)}` };
    } finally {
      await session.close();
    }
  };
}

/** The input the dispatch route hands the live port (the already-resolved review + material). */
export interface LiveDraftPrBodyInput {
  readonly review: Review;
  readonly base: string;
  readonly head: string;
  readonly narration?: { readonly oneLine: string; readonly paragraph: string };
  readonly dispositions: readonly { type: DispositionType; path: string; resolution: string }[];
  readonly requirements?: readonly string[];
  readonly decisions?: readonly string[];
}

/** The deps the live port is bound to (all injected so the module stays testable). */
export interface LiveDraftPrBodyDeps {
  /**
   * The reviewer's own role overrides, read per dispatch (#876). Absent means the council's
   * own tables decide, which is what every site did before the overrides were wired.
   */
  readonly councilOverrides?: CouncilOverrideReader;
  /**
   * The session's BOUND workspace for this review (session-bound-workspace D1) — the cwd this
   * turn runs in, and the root `writeContext` writes under. One value for both, because the
   * context path the prompt names is RELATIVE: write under the repository while the turn runs
   * in a worktree and the prompt points at a file that is not there. Absent ⇒ the repository
   * root, which is the binding for a branch review on the reviewer's own checkout.
   */
  turnRoot?(review: Review): string;
  /** The Claude harness adapter, or null when no `claude` is installed. */
  claudePort(repoRoot: string): Promise<HarnessPort | null>;
  /** The Codex executor resolved to the absolute binary (bead workspace-6qp15), or null.
   *  Receives the review's repo root (#334) so a WSL project resolves the distro seat. */
  codexExecutor(repoRoot: string): Promise<CodexExecutor | null>;
  /**
   * The ONE session-context writer, bound to the review's session id by the composition
   * root (`writeReviewContext`). Returns the directory it wrote into, relative to the
   * bound root — the prompt names THAT, never a dir re-derived from a review id, so the
   * files the turn is pointed at are the files `session.archive` purges (review finding 1).
   */
  writeContext(review: Review, files: readonly PromptContextFile[]): string;
}

/**
 * Build the LIVE `review.draftPrBody` port. Derives the council availability from
 * the same probes it executes on (claude adapter + codex executor), resolves the
 * model/effort through the council, and runs the one real turn on WHICHEVER harness
 * the council picked. Degrades to an honest `unavailable` (never a throw, never a
 * fabricated draft) only when NEITHER seat backs the resolved harness.
 */
export function createLiveDraftPrBodyPort(
  deps: LiveDraftPrBodyDeps,
): (input: LiveDraftPrBodyInput) => Promise<PrBodyDraftResult> {
  return async (input) => {
    // The session's bound workspace: this turn's cwd and the root its context files were
    // written under, which have to be the same value (session-bound-workspace 5.2).
    const turnRoot = deps.turnRoot?.(input.review) ?? input.review.repositoryRoot;
    // Probe both seats once; each probe is both an availability signal and the
    // executable. The council resolves pr-body-draft to Codex (Luna low) whenever
    // Codex is installed (Table 1 + 3), and to Claude (Haiku low) on a Claude-only
    // machine (Table 2); both are now live.
    const [claudePort, executor] = await Promise.all([
      deps.claudePort(turnRoot),
      deps.codexExecutor(turnRoot),
    ]);
    const installed: CouncilHarnessId[] = [];
    if (claudePort !== null) installed.push("claude-code");
    if (executor !== null) installed.push("codex");

    const resolution = resolveAssignment(
      PR_BODY_DRAFT_JOB_ID,
      councilContextFor(installed, deps.councilOverrides),
    );
    if (resolution.kind !== "model") {
      return { status: "unavailable", reason: "PR-body drafting resolved to no model seat" };
    }

    const harness = providerHarness(resolution.model);
    let port: PrBodyDraftPort | null = null;
    if (harness === "codex" && executor !== null) {
      port = codexDraftPrBodyPort(executor, resolution.model, resolution.effort, turnRoot);
    } else if (harness === "claude-code" && claudePort !== null) {
      // Follow the pipeline's Claude-seat convention: the council model rides the
      // result as provenance, but the session runs on the adapter's own default model.
      port = claudeDraftPrBodyPort(claudePort, turnRoot);
    }
    if (port === null) {
      return { status: "unavailable", reason: "PR-body drafting has no model seat installed" };
    }

    const draftInput: PrBodyDraftInput = {
      base: input.base,
      head: input.head,
      dispositions: input.dispositions,
      ...(input.narration === undefined ? {} : { narration: input.narration }),
      ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
      ...(input.decisions === undefined ? {} : { decisions: input.decisions }),
    };
    // The narration, dispositions, requirements and decisions go to disk under the repo
    // root the turn runs in, BEFORE the turn (session-context-files); the prompt names
    // only the files that exist, so it still never invites an invented section.
    const contextDir = deps.writeContext(input.review, prBodyContextFiles(draftInput));
    return draftPrBody(draftInput, contextDir, port, resolution.model);
  };
}
