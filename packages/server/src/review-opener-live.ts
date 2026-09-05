import type { PublishCompositionStore } from "@rennet/adapters";
import {
  type CodexExecutor,
  type CouncilOverrideReader,
  councilContextFor,
  draftReviewOpener,
  type HarnessPort,
  providerHarness,
  type ReviewOpenerDraftInput,
  type ReviewOpenerDraftResult,
  type ReviewOpenerPort,
  resolveAssignment,
  reviewOpenerContextFiles,
  reviewOpenerSourceId,
} from "@rennet/core";
import { type PromptContextFile, REVIEW_DRAFT_VOICE_FILE } from "@rennet/prompts";
import type { CouncilHarnessId, Review } from "@rennet/protocol";

const REVIEW_OPENER_JOB_ID = "publish-comment-prose";

export const REVIEW_OPENER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    opener: {
      type: "string",
      description:
        "One concise opening paragraph for the signed GitHub review, grounded only in the supplied facts and correct for the supplied verdict.",
    },
  },
  required: ["opener"],
  additionalProperties: false,
} as const;

function describeThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "an uncoercible non-Error value";
  }
}

function emittedOpener(output: unknown): { readonly status: "emitted"; readonly opener?: string } {
  const record = output as { opener?: unknown } | null;
  return {
    status: "emitted",
    ...(typeof record?.opener === "string" ? { opener: record.opener } : {}),
  };
}

export function codexReviewOpenerPort(
  executor: CodexExecutor,
  model: string,
  effort: string,
  cwd: string,
): ReviewOpenerPort {
  return async (prompt) => {
    try {
      const result = await executor({
        model,
        effort,
        prompt,
        cwd,
        outputSchema: REVIEW_OPENER_OUTPUT_SCHEMA,
        label: "review-opener",
      });
      return { ...emittedOpener(result.output), ...(result.model ? { model: result.model } : {}) };
    } catch (error) {
      return {
        status: "failed",
        reason: `the review-opener turn failed: ${describeThrow(error)}`,
        retryable: true,
      };
    }
  };
}

export function claudeReviewOpenerPort(port: HarnessPort, cwd: string): ReviewOpenerPort {
  return async (prompt) => {
    let session: Awaited<ReturnType<HarnessPort["createSession"]>>;
    try {
      session = await port.createSession({
        cwd,
        outputSchema: REVIEW_OPENER_OUTPUT_SCHEMA,
        ephemeral: true,
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `the review-opener session failed to start: ${describeThrow(error)}`,
        retryable: true,
      };
    }
    try {
      await session.send({ prompt });
      let actualModel: string | undefined;
      for await (const event of session.events) {
        if (event.kind === "session.started") actualModel = event.model;
        if (event.kind === "error")
          return { status: "failed", reason: event.error.message, retryable: true };
        if (event.kind !== "session.ended") continue;
        if (event.outcome.status === "failed") {
          return { status: "failed", reason: event.outcome.error.message, retryable: true };
        }
        if (event.outcome.status === "cancelled") {
          return {
            status: "failed",
            reason: "the review-opener turn was cancelled",
            retryable: true,
          };
        }
        if (event.outcome.structuredOutput === undefined) {
          return {
            status: "failed",
            reason: "the review-opener turn produced no structured output",
            retryable: true,
          };
        }
        return {
          ...emittedOpener(event.outcome.structuredOutput),
          ...(actualModel ? { model: actualModel } : {}),
        };
      }
      return {
        status: "failed",
        reason: "the review-opener turn ended without a terminal frame",
        retryable: true,
      };
    } catch (error) {
      return {
        status: "failed",
        reason: `the review-opener turn threw: ${describeThrow(error)}`,
        retryable: true,
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  };
}

export interface LiveReviewOpenerInput {
  readonly review: Review;
  readonly draft: ReviewOpenerDraftInput;
}

export interface LiveReviewOpenerDeps {
  /**
   * The reviewer's own role overrides, read per dispatch (#876). Absent means the council's
   * own tables decide, which is what every site did before the overrides were wired.
   */
  readonly councilOverrides?: CouncilOverrideReader;
  claudePort(repoRoot: string): Promise<HarnessPort | null>;
  codexExecutor(repoRoot: string): Promise<CodexExecutor | null>;
  readPrompt(file: string): string | Promise<string>;
  readonly store: PublishCompositionStore;
  /**
   * The ONE session-context writer, bound to the review's session id by the composition
   * root (`writeReviewContext`). Returns the directory it wrote into, relative to the
   * bound root — the prompt names THAT, never a dir re-derived from a review id, so the
   * files the turn is pointed at are the files `session.archive` purges (review finding 1).
   */
  writeContext(review: Review, files: readonly PromptContextFile[]): string;
  /**
   * The session's BOUND workspace for this review (session-bound-workspace D1) — the cwd this
   * turn runs in, and the root `writeContext` writes under. One value for both, because the
   * context path the prompt names is RELATIVE: write under the repository while the turn runs
   * in a worktree and the prompt points at a file that is not there. Absent ⇒ the repository
   * root, which is the binding for a branch review on the reviewer's own checkout.
   */
  turnRoot?(review: Review): string;
}

export function createLiveReviewOpenerPort(
  deps: LiveReviewOpenerDeps,
): (input: LiveReviewOpenerInput) => Promise<ReviewOpenerDraftResult> {
  const inFlight = new Map<string, Promise<ReviewOpenerDraftResult>>();
  let voiceRules: Promise<string> | undefined;
  const readVoiceRules = async (): Promise<string> => {
    const existing = voiceRules;
    if (existing) return existing;
    const loading = Promise.resolve().then(() => deps.readPrompt(REVIEW_DRAFT_VOICE_FILE));
    voiceRules = loading;
    try {
      return await loading;
    } catch (error) {
      if (voiceRules === loading) voiceRules = undefined;
      throw error;
    }
  };

  return async (input) => {
    const sourceId = reviewOpenerSourceId(
      input.review.id,
      input.review.activePatchsetId,
      input.draft,
    );
    const key = `${input.review.id}:${sourceId}`;
    const cached = deps.store.readReviewOpener(input.review.id, sourceId);
    if (cached.status === "stored") {
      return {
        status: "drafted",
        opener: cached.value.opener,
        model: cached.value.model,
      };
    }
    if (cached.status === "malformed") {
      return { status: "failed", reason: cached.reason };
    }

    const existing = inFlight.get(key);
    if (existing) return existing;

    const run = (async (): Promise<ReviewOpenerDraftResult> => {
      // The session's bound workspace: this turn's cwd and the root its context files were
      // written under, which have to be the same value (session-bound-workspace 5.2).
      const turnRoot = deps.turnRoot?.(input.review) ?? input.review.repositoryRoot;
      try {
        const [claudePort, executor] = await Promise.all([
          deps.claudePort(turnRoot),
          deps.codexExecutor(turnRoot),
        ]);
        const installed: CouncilHarnessId[] = [];
        if (claudePort !== null) installed.push("claude-code");
        if (executor !== null) installed.push("codex");
        const resolution = resolveAssignment(
          REVIEW_OPENER_JOB_ID,
          councilContextFor(installed, deps.councilOverrides),
        );
        if (resolution.kind !== "model") {
          return {
            status: "unavailable",
            reason: "review-opener drafting resolved to no model seat",
          };
        }

        const harness = providerHarness(resolution.model);
        const port =
          harness === "codex" && executor !== null
            ? codexReviewOpenerPort(executor, resolution.model, resolution.effort, turnRoot)
            : harness === "claude-code" && claudePort !== null
              ? claudeReviewOpenerPort(claudePort, turnRoot)
              : null;
        if (port === null) {
          return {
            status: "unavailable",
            reason: "review-opener drafting has no model seat installed",
          };
        }

        // The boards, the asks, the dismissals and the voice rules go to disk under the
        // repo root the seat runs in, BEFORE the turn starts (session-context-files). The
        // prompt then names them by relative path and the seat reads what it needs.
        const contextDir = deps.writeContext(
          input.review,
          reviewOpenerContextFiles(input.draft, await readVoiceRules()),
        );
        const drafted = await draftReviewOpener(contextDir, port, resolution.model);
        if (drafted.status !== "drafted") return drafted;

        const stored = deps.store.saveReviewOpener({
          reviewId: input.review.id,
          sourceId,
          opener: drafted.opener,
          model: drafted.model,
        });
        return stored.status === "stored"
          ? {
              status: "drafted",
              opener: stored.value.opener,
              model: stored.value.model,
            }
          : { status: "failed", reason: stored.reason };
      } catch (error) {
        return {
          status: "failed",
          reason: `the review opener could not be persisted: ${describeThrow(error)}`,
          retryable: true,
        };
      }
    })();
    inFlight.set(key, run);
    try {
      return await run;
    } finally {
      if (inFlight.get(key) === run) inFlight.delete(key);
    }
  };
}
