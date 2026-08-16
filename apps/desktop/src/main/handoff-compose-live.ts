import {
  type CodexExecutor,
  type ComposeGroup,
  type ComposePort,
  type ComposePortResult,
  composeHandoffBundle,
  type HarnessPort,
  providerHarness,
  resolveAssignment,
} from "@rennet/core";
import type {
  ComposedHandoffBundle,
  ComposeResolution,
  CouncilHarnessId,
  HandoffBundle,
  InvocationBudget,
} from "@rennet/types";

// ─────────────────────────────────────────────────────────────────────────────
// review.handoff.compose — the LIVE producer (issue #72, Model Council job M24).
//
// The structural sibling of `refine-comment-live.ts`, but ONE BATCHED call over the
// whole bundle (M24 is a `batched` job): the core `composeHandoffBundle` router owns
// the whole safety law (partition validation, verbatim-body reconstruction, the
// mechanical fail-closed floor) and is unit-proven; this module supplies the one
// real council-routed turn behind it, on whichever seat the council resolves
// (Terra-medium when Codex is installed, Sonnet on a Claude-only machine).
//
// A compose only degrades to the mechanical floor when NEITHER seat is installed OR
// the turn fails/returns an invalid partition — never a lossy authoring. Electron-free
// (injected functions as values), so it is unit-testable with fakes.
// ─────────────────────────────────────────────────────────────────────────────

/** The council job id for handoff-bundle composition (light tier, §2.3 M24). */
const COMPOSE_JOB_ID = "handoff-bundle-composition";

/**
 * The structured-output schema the compose turn is constrained to: an ordered list
 * of groups, each a one-line title plus the ids it merges. The model returns ONLY
 * this partition — never the ask bodies — so it is structurally incapable of dropping
 * or rewriting a note (the core router reconstructs bodies from the ids).
 */
export const COMPOSE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      description: "Groups in execution order (first runs first).",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "One plain line naming what the group accomplishes.",
          },
          dispositionIds: {
            type: "array",
            description:
              "The note ids merged into this group. Every id appears in exactly one group.",
            items: { type: "string" },
          },
        },
        required: ["title", "dispositionIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
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
 * Map a model's structured output to a `ComposePortResult` — shared by both seats.
 * A non-object, a missing/!array `groups`, or a malformed group is a FAILURE (never a
 * fabricated proposal); the core router then falls to the mechanical floor. A
 * well-formed partition rides through and the core validator enforces total-cover.
 */
export function mapComposeOutput(output: unknown): ComposePortResult {
  const record = output as { groups?: unknown } | null;
  if (record === null || typeof record !== "object" || !Array.isArray(record.groups)) {
    return { status: "failed", reason: "the compose turn returned no groups array" };
  }
  const groups: ComposeGroup[] = [];
  for (const raw of record.groups) {
    const group = raw as { title?: unknown; dispositionIds?: unknown } | null;
    if (
      group === null ||
      typeof group !== "object" ||
      typeof group.title !== "string" ||
      !Array.isArray(group.dispositionIds) ||
      !group.dispositionIds.every((id): id is string => typeof id === "string")
    ) {
      return { status: "failed", reason: "the compose turn returned a malformed group" };
    }
    groups.push({ title: group.title, dispositionIds: group.dispositionIds });
  }
  return { status: "emitted", proposal: { groups } };
}

/** Build a `ComposePort` over a Codex executor bound to the council-resolved model. */
export function codexComposePort(
  executor: CodexExecutor,
  model: string,
  effort: string,
): ComposePort {
  return async (prompt) => {
    try {
      const result = await executor({ model, effort, prompt, outputSchema: COMPOSE_OUTPUT_SCHEMA });
      return mapComposeOutput(result.output);
    } catch (error) {
      return { status: "failed", reason: `the compose turn failed: ${describeThrow(error)}` };
    }
  };
}

/**
 * Build a `ComposePort` over the Claude harness adapter. One light session with
 * `COMPOSE_OUTPUT_SCHEMA` passed to the SDK's `json_schema` output format — the same
 * structured-output mechanism every pipeline lens seat uses, so no docType is needed.
 * The compose turn only asks the model for an ordering/grouping partition; it performs
 * no file edits of its own. The drain mirrors `claudeRefinePort`.
 */
export function claudeComposePort(port: HarnessPort, cwd: string, model?: string): ComposePort {
  return async (prompt) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd,
        outputSchema: COMPOSE_OUTPUT_SCHEMA,
        ...(model === undefined ? {} : { model }),
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `the compose session failed to start: ${describeThrow(error)}`,
      };
    }
    try {
      await session.send({ prompt });
      for await (const event of session.events) {
        if (event.kind === "error") return { status: "failed", reason: event.error.message };
        if (event.kind === "session.ended") {
          const outcome = event.outcome;
          if (outcome.status === "completed") {
            if (outcome.structuredOutput === undefined) {
              return { status: "failed", reason: "the compose turn produced no structured output" };
            }
            return mapComposeOutput(outcome.structuredOutput);
          }
          if (outcome.status === "failed")
            return { status: "failed", reason: outcome.error.message };
          return { status: "failed", reason: "the compose turn was cancelled" };
        }
      }
      return { status: "failed", reason: "the compose turn ended without a terminal frame" };
    } catch (error) {
      return { status: "failed", reason: `the compose turn threw: ${describeThrow(error)}` };
    } finally {
      // F3: a rejected close() must not override an already-handled turn result (a
      // failed/empty outcome the try block returned). Swallow it — the compose result
      // is already determined; a teardown error cannot change it.
      await session.close().catch(() => undefined);
    }
  };
}

/** The deps the live composer is bound to (all injected so the module stays testable). */
export interface LiveComposeDeps {
  /** The Claude harness adapter, or null when no `claude` is installed. */
  claudePort(): Promise<HarnessPort | null>;
  /** The Codex executor resolved to the absolute binary, or null when no `codex`. */
  codexExecutor(): Promise<CodexExecutor | null>;
  /**
   * The review's shared invocation budget (issue #72, task 2.1; #260 semantics). When
   * present, one `tryConsume("handoff-bundle-composition")` is charged BEFORE the
   * turn: a refusal skips the seat so the core router returns the mechanical floor
   * (`composed:false`), never a block and never a fabricated composition. ABSENT ⇒
   * ungated (#260: "no budget means no ceiling, not no spend"), matching the ad-hoc
   * compose command that runs outside a pipeline run.
   */
  budget?(): InvocationBudget | undefined;
}

/** The input to one compose call: the mechanical bundle + the reviewed repo root. */
export interface LiveComposeInput {
  readonly bundle: HandoffBundle;
  /** The reviewed repo root — the read-only Claude compose session's working directory. */
  readonly repoRoot: string;
}

/**
 * The outcome of one live compose (issue #72, task 2.2): the composed bundle plus the
 * council resolution that produced it, so `review.handoff.compose` can answer "why did
 * this model run." A model-composed bundle carries the `resolved` seat. A floor with
 * no turn carries `unavailable`; a resolved seat that failed keeps its provenance and
 * records the actual `failureReason`.
 */
export interface LiveComposeResult {
  readonly bundle: ComposedHandoffBundle;
  readonly resolution: ComposeResolution;
}

/** The unavailable resolution the floor path records (no model turn ran). */
function floorResolution(summary: string): ComposeResolution {
  return { status: "unavailable", summary };
}

/**
 * Build the LIVE handoff-bundle composer. Resolves the council seat from the same
 * probes it executes on, charges the shared invocation budget when present, runs one
 * batched turn on whichever seat the council picked, and hands it to the core
 * `composeHandoffBundle` router. When NEITHER seat is installed, the budget refuses,
 * or a probe rejects, it composes with an always-`unavailable` port so the core router
 * returns the mechanical floor — never a throw, never a lossy authoring — and records
 * an honest `unavailable` resolution.
 */
export function createLiveComposeBundle(
  deps: LiveComposeDeps,
): (input: LiveComposeInput) => Promise<LiveComposeResult> {
  return async ({ bundle, repoRoot }) => {
    let port: ComposePort | null = null;
    let resolution: ComposeResolution = floorResolution("no compose seat installed");
    // F3: a seat probe that REJECTS (e.g. codex discovery throws) must not reject the
    // whole IPC command — it sits OUTSIDE the core router's fallback boundary. Catch it
    // here and fall to the deterministic mechanical floor (a real, complete bundle).
    try {
      const [claudePort, executor] = await Promise.all([deps.claudePort(), deps.codexExecutor()]);
      const installed: CouncilHarnessId[] = [];
      if (claudePort !== null) installed.push("claude-code");
      if (executor !== null) installed.push("codex");

      const resolved = resolveAssignment(COMPOSE_JOB_ID, { availability: { installed } });
      if (resolved.kind === "model") {
        const harness = providerHarness(resolved.model);
        if (harness === "codex" && executor !== null) {
          port = codexComposePort(executor, resolved.model, resolved.effort);
        } else if (harness === "claude-code" && claudePort !== null) {
          port = claudeComposePort(claudePort, repoRoot, resolved.model);
        }
        if (port !== null) {
          // The seat the turn will run on — recorded WITH the outcome (task 2.2) so the
          // product can answer "why did this model run" the way pipeline provenance does.
          resolution = {
            status: "resolved",
            harness: resolved.harness,
            model: resolved.model,
            effort: resolved.effort,
            summary: resolved.trace.summary,
          };
        }
      }
    } catch {
      port = null;
      resolution = floorResolution("the compose seat probe failed");
    }

    // Budget gate (task 2.1, #260): charge ONE invocation before the turn when a budget
    // is present. A refusal skips the seat — the core router returns the mechanical floor
    // and the outcome records an honest `unavailable` resolution (no model turn spent).
    // An ABSENT budget runs ungated (#260: absent = no ceiling, not no spend).
    if (port !== null) {
      const budget = deps.budget?.();
      if (budget !== undefined) {
        const grant = budget.tryConsume("handoff-bundle-composition");
        if (!grant.granted) {
          port = null;
          resolution = floorResolution(grant.reason);
        }
      }
    }

    // No seat, a refused budget, or a probe rejection uses an unavailable port. A real
    // seat is observed so a failed/malformed outcome can explain the floor without
    // being mislabeled as "no seat installed".
    let seatFailureReason: string | undefined;
    const composePort: ComposePort =
      port === null
        ? () => Promise.resolve({ status: "unavailable", reason: resolution.summary })
        : async (prompt) => {
            try {
              const outcome = await port(prompt);
              if (outcome.status !== "emitted") seatFailureReason = outcome.reason;
              return outcome;
            } catch (error) {
              seatFailureReason = `the compose turn threw: ${describeThrow(error)}`;
              throw error;
            }
          };
    const composed = await composeHandoffBundle(bundle, composePort);
    if (!composed.composed && port !== null && resolution.status === "resolved") {
      resolution = {
        ...resolution,
        failureReason:
          seatFailureReason ?? "the compose seat returned a composition that failed validation",
      };
    }
    return { bundle: composed, resolution };
  };
}
