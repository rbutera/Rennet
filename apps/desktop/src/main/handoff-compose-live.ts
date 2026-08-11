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
import type { ComposedHandoffBundle, CouncilHarnessId, HandoffBundle } from "@rennet/types";

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
          title: { type: "string", description: "One plain line naming what the group accomplishes." },
          dispositionIds: {
            type: "array",
            description: "The note ids merged into this group. Every id appears in exactly one group.",
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
export function codexComposePort(executor: CodexExecutor, model: string, effort: string): ComposePort {
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
 * Build a `ComposePort` over the Claude harness adapter. One light READ-ONLY session
 * with `COMPOSE_OUTPUT_SCHEMA` passed to the SDK's `json_schema` output format — the
 * same structured-output mechanism every pipeline lens seat uses, so no docType is
 * needed. Composition READS the diff and asks; it never writes, so the session stays
 * read-only. The drain mirrors `claudeRefinePort`.
 */
export function claudeComposePort(port: HarnessPort, cwd: string, model?: string): ComposePort {
  return async (prompt) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd,
        readOnly: true,
        outputSchema: COMPOSE_OUTPUT_SCHEMA,
        ...(model === undefined ? {} : { model }),
      });
    } catch (error) {
      return { status: "failed", reason: `the compose session failed to start: ${describeThrow(error)}` };
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
          if (outcome.status === "failed") return { status: "failed", reason: outcome.error.message };
          return { status: "failed", reason: "the compose turn was cancelled" };
        }
      }
      return { status: "failed", reason: "the compose turn ended without a terminal frame" };
    } catch (error) {
      return { status: "failed", reason: `the compose turn threw: ${describeThrow(error)}` };
    } finally {
      await session.close();
    }
  };
}

/** The deps the live composer is bound to (all injected so the module stays testable). */
export interface LiveComposeDeps {
  /** The Claude harness adapter, or null when no `claude` is installed. */
  claudePort(): Promise<HarnessPort | null>;
  /** The Codex executor resolved to the absolute binary, or null when no `codex`. */
  codexExecutor(): Promise<CodexExecutor | null>;
  /** The reviewed repo root — the read-only compose session's working directory. */
  repoRoot(): string;
}

/**
 * Build the LIVE handoff-bundle composer. Resolves the council seat from the same
 * probes it executes on, runs one batched turn on whichever seat the council picked,
 * and hands it to the core `composeHandoffBundle` router. When NEITHER seat is
 * installed, it composes with an always-`unavailable` port so the core router returns
 * the mechanical floor — never a throw, never a lossy authoring.
 */
export function createLiveComposeBundle(
  deps: LiveComposeDeps,
): (bundle: HandoffBundle) => Promise<ComposedHandoffBundle> {
  return async (bundle) => {
    const [claudePort, executor] = await Promise.all([deps.claudePort(), deps.codexExecutor()]);
    const installed: CouncilHarnessId[] = [];
    if (claudePort !== null) installed.push("claude-code");
    if (executor !== null) installed.push("codex");

    const resolution = resolveAssignment(COMPOSE_JOB_ID, { availability: { installed } });
    let port: ComposePort | null = null;
    if (resolution.kind === "model") {
      const harness = providerHarness(resolution.model);
      if (harness === "codex" && executor !== null) {
        port = codexComposePort(executor, resolution.model, resolution.effort);
      } else if (harness === "claude-code" && claudePort !== null) {
        port = claudeComposePort(claudePort, deps.repoRoot());
      }
    }
    // No seat backs the resolved harness: compose with an unavailable port so the core
    // router returns the deterministic mechanical floor (a real, complete bundle).
    const composePort: ComposePort =
      port ?? (() => Promise.resolve({ status: "unavailable", reason: "no compose seat installed" }));
    return composeHandoffBundle(bundle, composePort);
  };
}
