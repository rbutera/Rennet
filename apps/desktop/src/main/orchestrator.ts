import {
  deriveOrchestratorPrimerState,
  type LiveBackendDeps,
  type LoadCanvasOpsSdk,
  type LoadSdkQuery,
  type OrchestratorTurnResult,
  runOrchestratorTurn,
} from "@rennet/adapters";
import type { ReviewPipelineResult } from "@rennet/core";
import type { Review } from "@rennet/types";
import { createDesktopReviewBackend } from "./live-review-backend";

// ─────────────────────────────────────────────────────────────────────────────
// The desktop composition root for a live orchestrator turn (issue #13, wave 2).
//
// It composes the three ready pieces into ONE callable turn, without a
// conversational UI loop (deferred): assemble the wave-1 live backend
// (`createDesktopReviewBackend`, which generates the snapshot on open), derive the
// lean primer from that live state, and drive ONE model turn on the user's own
// `claude` (R2 subscription OAuth) with the in-process canvasOps@2 MCP server
// wired in. Like `createDesktopReviewBackend`, this module is electron-free (it
// takes `userDataDir` + a claude-path resolver as values) so it is unit-testable
// without spinning up Electron.
//
// "When an orchestrator turn is requested" = a call to the returned runner. The
// wave proves the backend + surface run LIVE (the gated real-turn proof); the chat
// UX that would call this per user question is the deferred loop.
// ─────────────────────────────────────────────────────────────────────────────

/** The app-level deps a turn runner is bound to (resolved lazily, per the app). */
export interface OrchestratorRunnerDeps {
  /** Where the app-owned ProjectSnapshot store lives (Electron userData). */
  readonly userDataDir: string;
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

/** Drive ONE orchestrator turn for a live review + built pipeline + question. */
export type OrchestratorTurnRunner = (
  review: Review,
  pipeline: ReviewPipelineResult,
  question: string,
) => Promise<OrchestratorTurnOutcome>;

/**
 * Build the orchestrator turn runner. Returns a function that, given a live review
 * + its built pipeline + a question, composes the live backend, derives the
 * primer, and drives ONE turn. With no discoverable `claude` it returns a typed
 * `unavailable` rather than crashing (mirroring the pipeline's honest degradation).
 */
export function createOrchestratorTurnRunner(deps: OrchestratorRunnerDeps): OrchestratorTurnRunner {
  return async (review, pipeline, question) => {
    const claudePath = await deps.resolveClaudePath();
    if (!claudePath) {
      return {
        available: false,
        reason: "no claude binary is available to orchestrate the review",
      };
    }

    const { backend, snapshot } = await createDesktopReviewBackend(review, pipeline, {
      userDataDir: deps.userDataDir,
      ...deps.backend,
    });
    const primer = deriveOrchestratorPrimerState(pipeline, backend, snapshot);

    const result = await runOrchestratorTurn(backend, primer, question, {
      claudePath,
      // KNOWN §7.2 DEVIATION (inherited, unchanged): the harness cwd is the live
      // mutable checkout, not an immutable materialisation of the patchset (#30,
      // deferred). Named so it is not silently widened.
      cwd: review.repositoryRoot,
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.loadQuery ? { loadQuery: deps.loadQuery } : {}),
      ...(deps.loadSdk ? { loadSdk: deps.loadSdk } : {}),
    });
    return { available: true, result };
  };
}
