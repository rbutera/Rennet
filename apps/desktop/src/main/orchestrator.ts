import {
  type CodexOrchestratorTurnDeps,
  deriveOrchestratorPrimerState,
  type LiveBackendDeps,
  type LoadCanvasOpsSdk,
  type LoadSdkQuery,
  type OmpOrchestratorTurnDeps,
  type OrchestratorTurnResult,
  runCodexOrchestratorTurn,
  runOmpOrchestratorTurn,
  runOrchestratorTurn,
} from "@rennet/adapters";
import type { CanvasOpsEffect, Locus, ReviewPipelineResult, UserAct } from "@rennet/core";
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
   * Resolve the council-selected harness for this orchestrator turn. Receives the
   * review's repository root (#334) so the composition root resolves the project's
   * locus — a WSL project runs the distro's claude/codex, not the host's.
   */
  resolveHarness(repoRoot: string): Promise<OrchestratorHarnessSelection | null>;
  /**
   * Resolve the project's execution locus (#334). Threaded into the codex/omp turn
   * so the canvasOps loopback surface binds to a distro-reachable address; absent ⇒
   * host, today's behaviour.
   */
  readonly resolveLocus?: (repoRoot: string) => Locus;
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

export type OrchestratorHarnessSelection =
  | {
      readonly harness: "claude-code";
      readonly claudePath: string;
      readonly model?: string;
    }
  | {
      readonly harness: "codex";
      readonly model?: string;
      readonly resolvePort: CodexOrchestratorTurnDeps["resolvePort"];
    }
  | {
      readonly harness: "omp";
      readonly model?: string;
      readonly resolvePort: OmpOrchestratorTurnDeps["resolvePort"];
    };

/**
 * The minimal orchestrator selection policy (#26). omp serves the seat ONLY when neither
 * Claude nor Codex is installed — where the seat was previously unavailable entirely.
 * Whenever either is present, the council decision (`council()`) is returned UNCHANGED,
 * so the Model Council's Claude/Codex assignment is byte-identical to today. Pure, so the
 * policy is asserted without the electron composition around it.
 */
export function resolveOrchestratorHarnessSelection(args: {
  readonly claudePresent: boolean;
  readonly codexPresent: boolean;
  readonly ompResolvePort: OmpOrchestratorTurnDeps["resolvePort"] | null;
  readonly council: () => OrchestratorHarnessSelection | null;
}): OrchestratorHarnessSelection | null {
  if (!args.claudePresent && !args.codexPresent) {
    return args.ompResolvePort ? { harness: "omp", resolvePort: args.ompResolvePort } : null;
  }
  return args.council();
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
    const selection = await deps.resolveHarness(review.repositoryRoot);
    if (!selection) {
      return {
        available: false,
        reason: "no model harness is available to orchestrate the review",
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
      const shared = {
        // KNOWN §7.2 DEVIATION (inherited, unchanged): the harness cwd is the live
        // mutable checkout, not an immutable materialisation of the patchset (#30).
        cwd: review.repositoryRoot,
        ...(selection.model === undefined ? {} : { model: selection.model }),
        ...(onDelta ? { onDelta } : {}),
        ...(contextFeed.assembledContext === undefined
          ? {}
          : { assembledContext: contextFeed.assembledContext }),
        onSend: contextFeed.onSend,
        ...(pointing?.userActs ? { userActs: pointing.userActs } : {}),
        ...(abortController ? { abortController } : {}),
      };
      // The distro-reachability of canvasOps depends on the project locus (#334):
      // a WSL codex/omp turn binds the loopback to an address the distro can reach.
      const locus = deps.resolveLocus?.(review.repositoryRoot);
      const externalShared =
        locus && locus.kind === "wsl" ? { ...shared, locus } : shared;
      const result =
        selection.harness === "codex"
          ? await runCodexOrchestratorTurn(backend, primer, question, {
              ...externalShared,
              resolvePort: selection.resolvePort,
            })
          : selection.harness === "omp"
            ? await runOmpOrchestratorTurn(backend, primer, question, {
                ...externalShared,
                resolvePort: selection.resolvePort,
              })
            : await runOrchestratorTurn(backend, primer, question, {
                ...shared,
                claudePath: selection.claudePath,
                ...(deps.env ? { env: deps.env } : {}),
                ...(deps.loadQuery ? { loadQuery: deps.loadQuery } : {}),
                ...(deps.loadSdk ? { loadSdk: deps.loadSdk } : {}),
              });
      return { available: true, result };
    } finally {
      contextFeed.complete();
    }
  };
}
