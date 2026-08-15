import {
  deriveOrchestratorPrimerState,
  type LiveBackendDeps,
  type LoadCanvasOpsSdk,
  type LoadSdkQuery,
  type OrchestratorTurnResult,
  runOrchestratorTurn,
} from "@rennet/adapters";
import type { CanvasOpsEffect, ReviewPipelineResult, UserAct } from "@rennet/core";
import type { Review } from "@rennet/types";
import { createDesktopReviewBackend, createDesktopReviewContextFeed } from "./live-review-backend";

// ─────────────────────────────────────────────────────────────────────────────
// The desktop composition root for a live orchestrator turn (issue #13, wave 2).
//
// It composes the three ready pieces into ONE callable turn, without a
// conversational UI loop (deferred): assemble the wave-1 live backend
// (`createDesktopReviewBackend`, which generates the snapshot on open), derive the
// lean primer from that live state, and drive ONE model turn on the user's own
// `claude` (R2 subscription OAuth) with the in-process canvasOps@2 MCP server
// wired in. Like `createDesktopReviewBackend`, this module is electron-free (it
// takes an optional `baseDir` + a claude-path resolver as values) so it is
// unit-testable without spinning up Electron.
//
// "When an orchestrator turn is requested" = a call to the returned runner. The
// wave proves the backend + surface run LIVE (the gated real-turn proof); the chat
// UX that would call this per user question is the deferred loop.
// ─────────────────────────────────────────────────────────────────────────────

/** The app-level deps a turn runner is bound to (resolved lazily, per the app). */
export interface OrchestratorRunnerDeps {
  /**
   * Base directory for the app-owned local-first ProjectSnapshot store. Omitted in
   * the app so the store defaults to `~/.rennet/projects/` (`defaultProjectsBaseDir`,
   * issue #188); a test injects a temp dir so it never touches the real home store.
   */
  readonly baseDir?: string;
  /**
   * Resolve the user's discovered `claude` binary path, or `null` when none is
   * installed. Bound to the app's memoized discovery; a turn refuses cleanly (never
   * crashes) when it returns `null`.
   */
  resolveClaudePath(): Promise<string | null>;
  /** Base env the spawned `claude` inherits (defaults to `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Extra live-backend deps (git, size ceiling, core state). */
  readonly backend?: Omit<LiveBackendDeps, "store">;
  /** SDK `query()` loader; defaults to the real lazy import. Injectable for tests. */
  readonly loadQuery?: LoadSdkQuery;
  /** canvasOps@2 MCP-server SDK loader; defaults to the real lazy import. Injectable for tests. */
  readonly loadSdk?: LoadCanvasOpsSdk;
  readonly onContextFeedError?: (error: unknown) => void;
}

/** A turn is unavailable when no `claude` binary was discovered (fail-closed, honest). */
export interface OrchestratorTurnUnavailable {
  readonly available: false;
  readonly reason: string;
}

/** A completed (or cleanly-failed) live turn. */
export interface OrchestratorTurnAvailable {
  readonly available: true;
  readonly result: OrchestratorTurnResult;
}

export type OrchestratorTurnOutcome = OrchestratorTurnAvailable | OrchestratorTurnUnavailable;

export interface OrchestratorTurnPointing {
  readonly onFocus?: (anchor: string) => void;
  readonly userActs?: readonly UserAct[];
}

/** Drive ONE orchestrator turn for a live review + built pipeline + question.
 *  `onDelta` (issue #251) streams each token as it arrives; omit it for a
 *  non-streaming turn that only reads the final text. `abortController` (issue #251,
 *  criterion 4) cancels the turn — the composition root holds it in the LiveTurnRegistry
 *  and fires it on `before-quit`, so an in-flight turn's `claude` child is asked to stop
 *  (via the SDK's `abortController` option) rather than surviving the quit. */
export type OrchestratorTurnRunner = (
  review: Review,
  pipeline: ReviewPipelineResult,
  question: string,
  onDelta?: (text: string) => void,
  abortController?: AbortController,
  pointing?: OrchestratorTurnPointing,
) => Promise<OrchestratorTurnOutcome>;

/**
 * Build the orchestrator turn runner. Returns a function that, given a live review
 * + its built pipeline + a question, composes the live backend, derives the
 * primer, and drives ONE turn. With no discoverable `claude` it returns a typed
 * `unavailable` rather than crashing (mirroring the pipeline's honest degradation).
 */
export function createOrchestratorTurnRunner(deps: OrchestratorRunnerDeps): OrchestratorTurnRunner {
  return async (review, pipeline, question, onDelta, abortController, pointing) => {
    const claudePath = await deps.resolveClaudePath();
    if (!claudePath) {
      return {
        available: false,
        reason: "no claude binary is available to orchestrate the review",
      };
    }

    const configuredApplyEffects = deps.backend?.core?.applyEffects;
    const { backend, snapshot } = await createDesktopReviewBackend(review, pipeline, {
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
      ...deps.backend,
      core: {
        ...deps.backend?.core,
        applyEffects: (effects: readonly CanvasOpsEffect[]) => {
          configuredApplyEffects?.(effects);
          for (const effect of effects) {
            if (effect.kind === "focus") pointing?.onFocus?.(effect.target);
          }
        },
      },
    });
    const primer = deriveOrchestratorPrimerState(pipeline, backend, snapshot);
    const contextFeed = await createDesktopReviewContextFeed(review, {
      ...(deps.baseDir ? { baseDir: deps.baseDir } : {}),
      ...(deps.onContextFeedError ? { onError: deps.onContextFeedError } : {}),
    });

    try {
      const result = await runOrchestratorTurn(backend, primer, question, {
        claudePath,
        // KNOWN §7.2 DEVIATION (inherited, unchanged): the harness cwd is the live
        // mutable checkout, not an immutable materialisation of the patchset (#30,
        // deferred). Named so it is not silently widened.
        cwd: review.repositoryRoot,
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.loadQuery ? { loadQuery: deps.loadQuery } : {}),
        ...(deps.loadSdk ? { loadSdk: deps.loadSdk } : {}),
        ...(onDelta ? { onDelta } : {}),
        ...(contextFeed.assembledContext === undefined
          ? {}
          : { assembledContext: contextFeed.assembledContext }),
        onSend: contextFeed.onSend,
        ...(pointing?.userActs ? { userActs: pointing.userActs } : {}),
        // #251 criterion 4: hand the SDK the AbortController so `before-quit` can cancel
        // the live claude turn. Absent → an uncancellable turn (fully back-compat).
        ...(abortController ? { abortController } : {}),
      });
      return { available: true, result };
    } finally {
      contextFeed.complete();
    }
  };
}
