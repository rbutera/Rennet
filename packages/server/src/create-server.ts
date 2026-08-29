// @rennet/server composition root (#377). `createRennetServer` performs the
// composition the Electron main process used to do inline: it builds the stores,
// adapters, harness memoizers, and the dispatch command router, and returns a
// handle the shell drives in-process today and a transport serialises in phase 2.
// Electron-owned effects (data dir, dialog, progress broadcast, shell.openPath,
// net.fetch, process env) arrive as options; nothing here imports electron.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Octokit } from "@octokit/core";
import {
  AskLogStore,
  applyVisibilitySwitch,
  BoardMetaStore,
  CLAUDE_TESTED_RANGE,
  type ClaudeHarnessResult,
  type CodexAvailability,
  captureRangePatchset,
  claudeHandoffRunPort,
  cleanupWorktree,
  contextAskBackend,
  createClaudeCiRefinementTurn,
  createClaudeHarness,
  createClientSettingsStore,
  createCodexCiRefinementTurn,
  createCodexExecutor,
  createCoverageTurn,
  createDaemonSettingsStore,
  createGitHubOctokit,
  createGitHubProjectPrSource,
  createRefPinner,
  createVerificationFileReaderForPatchset,
  createVerificationTurn,
  type DiscoveryDeps,
  defaultCodexDiscoveryDeps,
  defaultCodexExecEffects,
  defaultDiscoveryDeps,
  defaultForgeDetectionDeps,
  defaultFsListDirDeps,
  defaultGlobalConfigPath,
  defaultProjectDetailSourceDeps,
  defaultProjectDiscoveryDeps,
  deriveProjectDraft,
  discoverClaude,
  discoverCodex,
  discoverDesignArtifacts,
  discoverProject,
  discoverWorktreeIdentities,
  ensureManagedClone,
  ensureProjectSnapshotPin,
  ensurePrWorktree,
  execaGitFor,
  executeExternalCommand,
  FileProjectStore,
  FileThreadStore,
  GenerationStore,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitCaptureAdapter,
  GitCheckpointStore,
  type GitExec,
  GitHubChangesetSource,
  GitHubForgeAdapter,
  GitHubPrSubmissionAdapter,
  GitHubPublishAdapter,
  gitForRepoFactory,
  isGitHubNetworkError,
  KnowledgeStore,
  landRoundChanges,
  listDir,
  loadConventionCatalogue,
  loadProjectDetail,
  matchWorktree,
  migrateLegacyGlobalConfig,
  NoveltyLifecycleRegistry,
  ProjectContextReader,
  type ProjectPrSource,
  ProjectSnapshotGenerator,
  parseGitHubPrRef,
  prepareRoundWorkspace,
  prWorktreePath,
  RepoWatcher,
  RoundOperationConflictError,
  RoundOperationStore,
  RoundRecordStore,
  readOpenSpecChange,
  readSetupLogTail,
  readSetupStatus,
  readTreeLineCounts,
  refreshGitHubCredential,
  releaseRoundSourceCommit,
  removeRoundWorktree,
  repoHasSubmodules,
  repoKeyOf,
  repositoryIdentity,
  resolveForgeRemote,
  resolveGitHubAuth,
  resolveTrackerConfig,
  runConfiguredRoundGate,
  detectForges as runForgeDetection,
  runGitHubDeviceFlow,
  runPrWorktreeSetup,
  runRelatedContextRetrieval,
  SessionStore,
  SnapshotOverlayReader,
  SnapshotOverlayStore,
  SqliteReviewStore,
  saveConventionCatalogue,
  scoutSettingsOffers,
  settleRoundCommits,
  snapshotStoreFor,
  TranscriptStore,
  validateGitHubToken,
  withRepoPref,
  wslDiscoveryDeps,
  wslForgeDetectionDeps,
} from "@rennet/adapters";
import {
  attachRiskCrossCheck,
  buildHandoffBundle,
  buildOfferedManifest,
  buildReviewCanvases,
  type CodexExecutor,
  classifyUiSurface,
  createHarnessRunTurn,
  createInvocationBudget,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
  decompose,
  detectLocus,
  escapePath,
  type ForgePrSubmission,
  type ForgePrSubmissionOutcome,
  findingDispositionMigrationEvents,
  guardSeatTurn,
  type HandoffTurnOutcome,
  type HarnessPort,
  type HarnessTurnResult,
  HOST_LOCUS,
  handoffDispositionsFromProjection,
  type Locus,
  LocusDistroMismatchError,
  LocusPathUntranslatableError,
  mechanicalComposition,
  mintSession,
  queryKnowledge,
  queryProjectMap,
  ReviewService,
  recordSeatSend,
  resolveAssignment,
  resolveLocus,
  runCoverageMapping,
  runHandoffTurn as runHandoffTurnCore,
  runNoiseAngle,
  toDistroPath,
  toWindowsView,
  verifyFlaggedReview,
} from "@rennet/core";
import type {
  ConventionCatalogue,
  CouncilHarnessId,
  DetectedForge,
  DetectedHarness,
  FlaggedReview,
  GitHubAuthStatus,
  GitHubConnectPoll,
  KnowledgeDispositionResult,
  LensKind,
  NoiseReview,
  OpenSpecCoverage,
  Patchset,
  Project,
  ProjectContextAskResult,
  ProjectContextMapResult,
  ProjectProcessEvent,
  ProjectSource,
  Review,
  RoundEvent,
  RoundOperation,
  RoundRunReceipt,
  SessionModel,
} from "@rennet/protocol";
import {
  currentGenerationId,
  isRoundOperationTerminal,
  roundOperationProgressSnapshot,
  sha256Hex,
} from "@rennet/protocol";
import { buildAppTools } from "./agent-tools";
import { type BoardsRuntime, createBoardsRuntime } from "./boards/boards-runtime";
import { attachCiSignal } from "./ci-signal";
import { createLiveDeltaDigestPort } from "./delta-digest-live";
import { createDispatch, type FlaggedReviewRun } from "./dispatch";
import {
  activeRoundDraft,
  consumeCurrentAskOccurrences,
  projectionForAskOccurrences,
} from "./dispatch/round";
import { sidebarSessionOf } from "./dispatch/session";
import { createLiveDraftPrBodyPort } from "./draft-pr-body-live";
import { stampBlockingStates } from "./flagged-blocking-states";
import { composeFlaggedLateEnrichment } from "./flagged-late-enrichment";
import { projectUnavailableDeepVerification } from "./flagged-review-verification";
import { applyImmediateUiVerification } from "./flagged-ui-verification";
import { composeGitHubTransport } from "./github-fetch";
import { createGitHubTokenStore } from "./github-token-store";
import { createLiveComposeBundle } from "./handoff-compose-live";
import { InFlightReviews } from "./in-flight-reviews";
import { liveProbe, liveProbeMap } from "./live-detection";
import { createDesktopReviewBackend, createDesktopReviewContextFeed } from "./live-review-backend";
import { LiveTurnRegistry } from "./live-turn-registry";
import {
  createEditorLaunchEffects,
  editorLaunchSpec,
  performOpenInEditor,
  resolveEditorExecutables,
} from "./open-in-editor";
import { PairingStore } from "./pairing-store";
import {
  createProactiveRehydration,
  type ProactiveRehydration,
  proactiveRehydrationCommandId,
} from "./proactive-rehydration";
import { createProcessProject } from "./process-project";
import { buildProjectionContext } from "./projection";
import { PushTokenStore } from "./push-token-store";
import { createLiveRefinePort } from "./refine-comment-live";
import {
  CODEX_ASK_LABEL,
  createLiveCodexAsk,
  createLiveOrchestratorAsk,
  createLiveReviewAskPorts,
} from "./review-ask-live";
import { type ReviewContextFeed, runWithReviewContextFeed } from "./review-context-feed";
import type { ReviewIntelligenceSession } from "./review-intelligence-session";
import { createKnowledgeSwarmRuntime } from "./runtime/knowledge-swarm";
import { projectLensBoard, readRoundReportBoardForRecord } from "./runtime/lens-board-read";
import { createNodePromptReader } from "./runtime/lens-pipeline";
import { createProjectScoutRuntime } from "./runtime/project-scout";
import {
  type BoardRegenerationDeps,
  generationBoardMeta,
  readPriorGeneration,
  runBoardRegeneration,
} from "./runtime/round-collation";
import {
  createRoundExecutionCoordinator,
  type RoundExecutionPorts,
} from "./runtime/round-execution";
import { RoundProgressHub } from "./runtime/round-progress";
import {
  createRoundsRuntime,
  type DispatchRoundResult,
  type PersistedBoardMeta,
} from "./runtime/rounds";
import { resolveCaptureRoot } from "./session/capture-root";
import {
  enterRoundSession,
  projectIdForRepoRoot,
  resolveRoundSessionId,
  SessionEntry,
} from "./session/session-entry";
import {
  createContextRebuiltEmit,
  createTranscriptCapture,
  turnLoopRunPort,
} from "./session/turn-capture";
import { SessionTurnLoop } from "./session/turn-loop";
import { createSettingsComposition } from "./settings";
import { findHealthyDaemon } from "./supervise";
import { createLiveSymbolLookup, reviewPinnedToHead } from "./symbol-lookup-live";
import { startWsListener, type WsListener } from "./ws-listener";
import { createWslRunner } from "./wsl-daemon";
import { ensureWslDaemon, probeWslDaemon } from "./wsl-supervisor";

/**
 * Ask ONE host's daemon whether it is running and on which version — the read behind the
 * settings surface's host cards (C17, #485). Each host kind is asked the only way it CAN be
 * asked from here, and a kind with no way to reach it answers `null`, which the caller
 * reports as unreachable. Nothing here ever returns a version it did not observe:
 *
 *  • `local` — this process IS that host's daemon, and it is answering right now, so the
 *    host is reachable by construction. `findHealthyDaemon` names the RUNNING version off
 *    the verified claim; a stale or absent claim file falls back to the version of the
 *    daemon executing this line. Both are observed facts, never a guess.
 *  • `wsl:<distro>` — probed INSIDE the distro over `wsl.exe` (`probeWslDaemon`): resolve
 *    `$HOME`, read the published port, health-check it. No spawn, no bundle delivery, no
 *    restart — a status read must not start a daemon that was not running.
 *  • `remote:<deviceId>` — a paired device DIALS this daemon; there is no outbound
 *    connection to dial back, so its daemon cannot be reached from here. `null`.
 */
async function probeDaemonForHost(
  source: ProjectSource,
  dataDir: string,
  serverVersion: string,
): Promise<{ version: string | null } | null> {
  if (source === "local") {
    const verdict = await findHealthyDaemon(dataDir);
    const claimed =
      verdict.kind === "healthy" || verdict.kind === "incompatible"
        ? verdict.identity.version
        : null;
    return { version: claimed ?? serverVersion };
  }
  if (source.startsWith("wsl:")) {
    const identity = await probeWslDaemon(source.slice("wsl:".length), {
      run: createWslRunner(),
    });
    return identity ? { version: identity.version } : null;
  }
  return null;
}

/**
 * RE-ATTEMPT one host's handshake on demand (C17 cluster 5, #533) — the effect behind the host
 * card's Reconnect button. It is the same handshake `probeDaemonForHost` performs, run fresh for
 * one host, with one difference: a host kind that cannot be reached from here at ALL throws its
 * reason instead of resolving `null`, so the card can say WHY rather than showing a bare failure.
 *
 * What it deliberately does NOT do is start a daemon that is not running. Delivering a bundle
 * and spawning inside a distro is the UPDATE path (`ensureWslDaemon`, which owns the host bundle
 * the shell resolves) — Reconnect re-attempts the connection and reports what it found, and a
 * button that quietly installed software would be a different action wearing this one's label.
 */
async function reconnectDaemonForHost(
  source: ProjectSource,
  dataDir: string,
  serverVersion: string,
): Promise<{ version: string | null } | null> {
  if (source.startsWith("remote:")) {
    throw new Error(
      "A paired device dials this daemon; Rennet cannot dial back to reconnect it. Reconnect from that device.",
    );
  }
  const answer = await probeDaemonForHost(source, dataDir, serverVersion);
  if (!answer && source.startsWith("wsl:")) {
    throw new Error(
      `No Rennet daemon answered in WSL distro "${source.slice("wsl:".length)}". Open a project on that distro to start one.`,
    );
  }
  return answer;
}

export type HandoffTurnExecution =
  | { readonly kind: "host" }
  | { readonly kind: "wsl"; readonly distro: string; readonly cwd: string };

export interface HandoffTurnInput {
  readonly repoRoot: string;
  readonly prompt: string;
  /**
   * The persisted session this turn belongs to, when it has one. Present means the turn runs
   * through the session turn loop. An absent or unknown session uses the plain one-shot port.
   */
  readonly sessionId?: string;
  readonly execution?: HandoffTurnExecution;
}

export async function captureBranchPatchset(input: {
  readonly git: GitExec;
  readonly locus: Locus;
  readonly repoPath: string;
  readonly head: string;
  readonly base: string;
  readonly resolveProjectSnapshotId: (repositoryRoot: string, baseOid: string) => Promise<string>;
}): Promise<Patchset> {
  const gitRoot = (await input.git(input.repoPath, ["rev-parse", "--show-toplevel"])).trim();
  const root = input.locus.kind === "wsl" ? toWindowsView(gitRoot, input.locus.distro) : gitRoot;
  const headOid = (
    await input.git(root, ["rev-parse", "--verify", `${input.head}^{commit}`])
  ).trim();
  const baseOid = (await input.git(root, ["merge-base", input.base, headOid])).trim();
  return captureRangePatchset(input.git, {
    root,
    locus: input.locus,
    baseOid,
    headOid,
    baseRef: input.base,
    headRef: input.head,
    source: "local-branch",
    projectSnapshotId: await input.resolveProjectSnapshotId(root, baseOid),
  });
}

function detectedLocusForRepo(repoRoot: string): Locus {
  return resolveLocus(detectLocus(repoRoot)).value;
}

function handoffTurnExecution(locus: Locus, repoRoot: string): HandoffTurnExecution {
  if (locus.kind === "host") return { kind: "host" };
  const cwd = toDistroPath(repoRoot, locus.distro);
  if (cwd === null) throw new LocusPathUntranslatableError(repoRoot, locus.distro);
  return { kind: "wsl", distro: locus.distro, cwd };
}

export function roundWorkerTurnInput(input: {
  readonly sourceRepoRoot: string;
  readonly worktreePath: string;
  readonly prompt: string;
  readonly sessionId: string;
}): HandoffTurnInput {
  return {
    repoRoot: input.worktreePath,
    prompt: input.prompt,
    sessionId: input.sessionId,
    execution: handoffTurnExecution(detectedLocusForRepo(input.sourceRepoRoot), input.worktreePath),
  };
}

export function createRoundWorkspacePlanner(input: {
  readonly dataDir: string;
  readonly sourceRepositoryFor: (operation: RoundOperation) => {
    readonly reviewedTreeOid?: string;
    readonly headOid: string;
    readonly commonDir: string;
  };
  readonly now?: () => number;
}): RoundExecutionPorts["planWorkspace"] {
  return (operation) => {
    const repository = input.sourceRepositoryFor(operation);
    const key = sha256Hex(operation.operationId).slice(0, 32);
    const sourceLocus = detectedLocusForRepo(operation.repoRoot);
    let worktreePath: string;
    if (sourceLocus.kind === "host") {
      worktreePath = join(input.dataDir, "round-worktrees", key);
    } else {
      const commonDir = toDistroPath(repository.commonDir, sourceLocus.distro);
      if (commonDir === null) {
        throw new LocusPathUntranslatableError(repository.commonDir, sourceLocus.distro);
      }
      const separator = commonDir.endsWith("/") ? "" : "/";
      worktreePath = toWindowsView(
        `${commonDir}${separator}rennet-round-worktrees/${key}`,
        sourceLocus.distro,
      );
    }
    return {
      kind: "detached-worktree",
      worktreePath,
      sourceTreeOid: repository.reviewedTreeOid ?? `${repository.headOid}^{tree}`,
      sourceParentHead: repository.headOid,
      startedAt: (input.now ?? Date.now)(),
    };
  };
}

export function createRoundWorkerPort(input: {
  readonly runHandoffTurn: (turn: HandoffTurnInput) => Promise<HandoffTurnOutcome>;
  readonly now?: () => number;
}): RoundExecutionPorts["runWorker"] {
  return async ({ operation, attempt }) => {
    if (operation.state.phase !== "worker-running") {
      throw new Error("Round worker started outside its durable running phase.");
    }
    const outcome = await input.runHandoffTurn(
      roundWorkerTurnInput({
        sourceRepoRoot: operation.repoRoot,
        worktreePath: operation.state.workspace.worktreePath,
        prompt: operation.workOrderPrompt,
        sessionId: operation.sessionId,
      }),
    );
    const evidence = {
      ...attempt,
      completedAt: (input.now ?? Date.now)(),
      diff: outcome.turnDiff,
      changedPaths: [...outcome.filesTouched],
    };
    return outcome.status === "failed"
      ? {
          ...evidence,
          outcome: "failed" as const,
          termination: { kind: "error" as const, reason: outcome.reason },
        }
      : { ...evidence, outcome: "completed" as const };
  };
}

export interface RennetServerOptions {
  /**
   * The per-user data directory (Electron passes app.getPath("userData")). The SQLite store,
   * the daemon claim and the log resolve under it — but NOT every store: the settings ladder
   * (`client-settings.json`, `daemon-settings.json`, `devices.json`) lives under `$HOME/.rennet`
   * by design, so a spawned daemon writes the real user's settings whatever `dataDir` says.
   */
  readonly dataDir: string;
  /** Process environment for harness/CLI resolution and the RENNET_TEST_REPO short-circuit. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** The repository-chooser fallback (Electron's directory dialog); used only when RENNET_TEST_REPO is unset. */
  readonly chooseRepositoryFallback?: () => Promise<string | null>;
  /** Broadcast a background-rehydration progress event to every client (Electron: every open window). */
  readonly broadcastProgress?: (commandId: string, event: ProjectProcessEvent) => void;
  /** Open a path in the OS (Electron's shell.openPath), the editor-launch fallback; resolves whether it opened. */
  readonly openPath?: (absPath: string) => Promise<boolean>;
  /** The outbound HTTP transport for GitHub egress (the daemon's global fetch). */
  readonly httpFetch?: typeof globalThis.fetch;
  /** Per-request deadline on GitHub egress (tests shrink it). Default 15s. */
  readonly httpTimeoutMs?: number;
  /** The server application's own version, surfaced in the WS `serverInfo` handshake. Defaults to a dev sentinel. */
  readonly serverVersion?: string;
  /**
   * Directory of a built browser UI to serve over the HTTP port (issue #381). Absent ⇒
   * the daemon runs headless. Passed straight to the WS listener's static handler.
   */
  readonly uiDist?: string;
  /**
   * This daemon's own server bundle on the host filesystem — the artifact a WSL daemon UPDATE
   * delivers into the distro (C17 cluster 6, #534). `spawnDaemon` passes the entry it launched,
   * which IS that bundle. Absent ⇒ this process cannot deliver one (a daemon started some other
   * way), so a WSL update reports that plainly instead of shipping the wrong file.
   */
  readonly hostBundlePath?: string;
  /** Hermetic production-mapping seam for the coding turn. Tests use it to prove the
   * composition root carries checkpoint evidence even when HEAD does not move. */
  readonly runHandoffTurn?: (input: HandoffTurnInput) => Promise<HandoffTurnOutcome>;
  /** Test observation at the crash commit point, before any PR-draft ripening await. */
  readonly onRoundPlaceholderCommitted?: (input: {
    readonly sessionId: string;
    readonly dispatchId: string;
  }) => void | Promise<void>;
}

export interface RennetServer {
  /** The command router — the exact function createDispatch returns; the DispatchContext push seam is unchanged. */
  readonly dispatch: ReturnType<typeof createDispatch>;
  /** The ephemeral loopback port the WS listener bound (#378); the desktop injects it into the renderer. */
  readonly wsPort: number;
  /** The host the WS listener bound (`127.0.0.1` by default, or the configured `daemon.listen.host`, #380). */
  readonly wsHost: string;
  /** Quiesce live turns, close the watcher, close rehydration, close the store, close the WS listener. Idempotent. */
  readonly shutdown: () => void;
  /**
   * The boards runtime for a review project (B4) — one embedded board service per
   * project root, its appends broadcast on the WS push path (raw to loopback,
   * privacy-wrapped to projected connections). B8's lens pipeline writes through
   * whiteboard-client over `boardsRuntimeFor(root).service`.
   */
  readonly boardsRuntimeFor: (projectRoot: string) => BoardsRuntime;
}

export async function createRennetServer(options: RennetServerOptions): Promise<RennetServer> {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir;
  const serverVersion = options.serverVersion ?? "0.0.0-dev";

  let editorExecutables: Promise<string[]> | null = null;
  function getEditorExecutables(): Promise<string[]> {
    editorExecutables ??= (async () => {
      const discovery = defaultDiscoveryDeps();
      const loginShellPath = (await discovery.loginShellPath()) ?? "";
      return resolveEditorExecutables(
        {
          platform: process.platform,
          home: homedir(),
          inheritedPath: env.PATH ?? "",
          loginShellPath,
        },
        async (candidate) => {
          try {
            await access(candidate, fsConstants.X_OK);
            return true;
          } catch {
            return false;
          }
        },
      );
    })();
    return editorExecutables;
  }

  const editorLaunchEffects = createEditorLaunchEffects({
    resolveExecutables: getEditorExecutables,
    async spawn(executable, args) {
      const spec = editorLaunchSpec(executable, args);
      await executeExternalCommand(spec.file, spec.args);
    },
    openPath: options.openPath ?? (async () => false),
  });
  const liveSnapshotStore = snapshotStoreFor(join(dataDir, "projects"));
  const liveNoveltyLifecycle = new NoveltyLifecycleRegistry();

  /**
   * The effective execution locus for a repo path (add-windows-support): a DETECTED
   * FACT (#476), auto-detected from the path (a `\\wsl$` root ⇒ that distro, else
   * host). Every repo-facing spawn in this composition routes through it, so a
   * WSL-path project's git/harness runs inside the distro (Rule Zero: a plain
   * resolution, never a gate). A stale stored `config.locus` is deliberately NOT
   * consumed here — execution matches exactly what the settings surface displays as
   * detected, so the two can never disagree.
   */
  function locusForRepo(repoRoot: string): Locus {
    return detectedLocusForRepo(repoRoot);
  }

  /**
   * The locus + distro-native cwd for a repo, the shape every read-pipeline harness
   * site threads (#334). For a WSL locus `distroCwd` is the distro-native repo path
   * the SDK/`--cd` needs; for the host it is absent and the pair is today's behaviour.
   */
  function locusContextForRepo(repoRoot: string): { locus: Locus; distroCwd?: string } {
    const locus = locusForRepo(repoRoot);
    if (locus.kind !== "wsl") return { locus };
    // A WSL locus pinned onto an untranslatable repo path (e.g. a `C:\` repo) is a
    // broken pin: reject it plainly here rather than collapsing null → undefined and
    // letting a downstream harness run against the host path (Codex FAIL #1).
    const distroCwd = toDistroPath(repoRoot, locus.distro);
    if (distroCwd === null) throw new LocusPathUntranslatableError(repoRoot, locus.distro);
    return { locus, distroCwd };
  }

  const gitForRepo = gitForRepoFactory(locusForRepo);

  /** The ProjectSnapshot store key for a repo root: `escapePath(realpath(top-level))` (design §1.1). */
  function repoKeyForRoot(repoRoot: string): string {
    try {
      return escapePath(realpathSync(repoRoot));
    } catch {
      return escapePath(repoRoot);
    }
  }

  const capture = new GitCaptureAdapter(
    undefined,
    (repoRoot, baseOid) =>
      ensureProjectSnapshotPin(liveSnapshotStore, repoRoot, baseOid, gitForRepo(repoRoot)),
    locusForRepo,
  );
  const watcher = new RepoWatcher();

  // Composition root for the Claude harness. This binds the REAL
  // @anthropic-ai/claude-agent-sdk query() (via createClaudeHarness) to the
  // ClaudeAdapter, passing the user's own discovered `claude` binary so auth stays
  // on their subscription OAuth (Master Plan R2). It is composed LAZILY and
  // memoized: discovery spawns the user's login shell, so it runs on first use
  // (the first `review.canvases`) rather than at launch, and passes the full
  // process env so the spawned harness inherits PATH/HOME.
  // Memoized PER LOCUS+CWD (add-windows-support): the host harness is shared as before;
  // a WSL-locus project gets a harness that discovers and runs the distro's own `claude`
  // through `wsl.exe` (createClaudeHarness), with capability identical to native. The
  // memo key includes the distro cwd because it is prepended to every SDK spawn; each
  // distro+repo is composed at most once. `distroCwd` is the distro-native repo path.
  const claudeHarnesses = new Map<string, Promise<ClaudeHarnessResult>>();
  function getClaudeHarness(
    locus: Locus = HOST_LOCUS,
    distroCwd?: string,
  ): Promise<ClaudeHarnessResult> {
    const key = locus.kind === "wsl" ? `wsl:${locus.distro}:${distroCwd ?? ""}` : "host";
    let harness = claudeHarnesses.get(key);
    if (!harness) {
      harness = createClaudeHarness({
        env,
        locus,
        ...(distroCwd === undefined ? {} : { wslCwd: distroCwd }),
      });
      claudeHarnesses.set(key, harness);
    }
    return harness;
  }

  // The Codex seat, wired to a RESOLVED ABSOLUTE `codex` binary (#66, #69, R39;
  // bead workspace-6qp15). Bare `codex` on PATH is the asdf SHIM, which under
  // version drift launches a broken install, so the Codex seat silently fails to
  // start and dual-model degrades to single-Claude at the PROCESS layer (a layer
  // below the #212 schema fix). So the composition root resolves an absolute codex
  // ONCE — login-shell PATH + curated asdf-install locations, each PROVEN by
  // `codex --version`, preferring a real install over the shim — and binds the
  // executor to that path. Composed LAZILY and memoized like the Claude harness:
  // resolution spawns the login shell + a probe, so it runs on first use.
  //
  // The INVARIANT the composition root maintains — `codex` is `available` (and in
  // `installed`) IFF a resolvable binary was found and the port is passed to the
  // pipeline — is what makes a Codex resolution always executable. When nothing
  // resolves, `port` is null and `available` is false: the pipeline gets NO Codex
  // seat and falls to single-Claude with the EXISTING honest DEGRADED marker, never
  // a silent single-seat masquerading as a dual-model run.
  interface CodexResolution {
    readonly availability: CodexAvailability;
    /**
     * Build the utility executor for one repository (W5). Per-repo, not per-locus:
     * a utility seat roots at the checkout it is reasoning about, exactly as the
     * Claude legs of the same council-routed jobs do. Discovery stays memoized per
     * locus; only this closure is applied per review. Null ⇒ no codex resolved.
     */
    readonly makeExecutor: ((repoRoot: string) => CodexExecutor) | null;
    /** The resolved absolute `codex` path (for the ask-AI executor), or null. */
    readonly binPath: string | null;
    /** The resolved codex version, stamped as harness provenance, or null. */
    readonly version: string | null;
  }
  // Memoized PER LOCUS (add-windows-support / #334), like the Claude harness: the host
  // resolution is shared as before; a WSL-locus project discovers and runs the DISTRO's
  // own `codex` (distro discovery deps, locus-wrapped executor, distro-side scratch).
  // The utility executor carries the locus so every spawn enters the distro through
  // `locusCommand` — a WSL review is dual-harness rather than degrading to
  // single-Claude. (The agentic transport this once also built went with the dead
  // `agenticPort`, F1: the orchestrator is Claude.)
  const codexResolutions = new Map<string, Promise<CodexResolution>>();
  function getCodexResolution(locus: Locus): Promise<CodexResolution> {
    const key = locus.kind === "wsl" ? `wsl:${locus.distro}` : "host";
    let resolution = codexResolutions.get(key);
    if (!resolution) {
      resolution = (async (): Promise<CodexResolution> => {
        // The hermetic-test hook (#386): see createClaudeHarness.
        if (env.RENNET_DISABLE_HARNESS === "1") {
          return {
            availability: { available: false, version: null },
            makeExecutor: null,
            binPath: null,
            version: null,
          };
        }
        const explicitBin = env.RENNET_CODEX_BIN;
        const discoveryDeps =
          locus.kind === "wsl" ? await wslDiscoveryDeps(locus.distro) : defaultCodexDiscoveryDeps();
        const result = await discoverCodex(discoveryDeps, {
          // The RENNET_CODEX_BIN override is a host path; it never applies to a distro.
          ...(locus.kind === "host" && explicitBin && explicitBin.length > 0
            ? { explicitBin }
            : {}),
        });
        const chosen = result.chosen;
        if (!chosen) {
          return {
            availability: { available: false, version: null },
            makeExecutor: null,
            binPath: null,
            version: null,
          };
        }
        const makeExecutor = (repoRoot: string): CodexExecutor =>
          createCodexExecutor(defaultCodexExecEffects, {
            bin: chosen.path,
            harnessVersion: chosen.version,
            ...(chosen.runtimePath === undefined ? {} : { runtimePath: chosen.runtimePath }),
            ...(locus.kind === "wsl" ? { locus } : {}),
            repoRoot,
          });
        return {
          availability: { available: true, version: chosen.version },
          makeExecutor,
          binPath: chosen.path,
          version: chosen.version,
        };
      })();
      codexResolutions.set(key, resolution);
    }
    return resolution;
  }

  // The locus-aware seat probes the live producers (refine, draft-PR-body, delta digest,
  // compose) are bound to (#334). Each resolves the review's locus, so a WSL project's
  // light-tier turn runs the distro's claude/codex — not the host's.
  async function claudeAdapterForRepo(repoRoot: string): Promise<HarnessPort | null> {
    const { locus, distroCwd } = locusContextForRepo(repoRoot);
    return (await getClaudeHarness(locus, distroCwd)).adapter ?? null;
  }
  /** The utility executor for a repo, ROOTED AT THAT CHECKOUT (W5) — locus-native, so a
   *  WSL project's seat gets the distro path the distro's codex can actually open. */
  async function codexExecutorForRepo(repoRoot: string): Promise<CodexExecutor | null> {
    const { locus, distroCwd } = locusContextForRepo(repoRoot);
    const { makeExecutor } = await getCodexResolution(locus);
    return makeExecutor === null ? null : makeExecutor(distroCwd ?? repoRoot);
  }

  // The in-flight shares behind every detection read below (C17 review finding 2).
  const shareHarnessDetection = liveProbe<DetectedHarness[]>();
  const shareHarnessDetectionByHost = liveProbeMap<DetectedHarness[] | null>();
  const shareForgeDetection = liveProbe<DetectedForge[]>();
  const shareForgeDetectionByHost = liveProbeMap<DetectedForge[] | null>();

  // The ambient first-run detection line (issue #29): which harnesses are on the
  // machine. Read-only, no repository, no model call — it is DISCLOSURE, felt not
  // ceremonial. A probe that finds nothing simply drops that harness; the line degrades
  // to whatever was found (or nothing), never an error.
  //
  // LIVE, not memoized (C17 review finding 2): the probes spawn a login shell, so concurrent
  // readers share the RUNNING probe — but the answer is never kept past it. Installing or
  // removing `claude` used to be invisible until the daemon restarted, which is a stale answer
  // presented as a live detection. Codex is probed HERE rather than through
  // `getCodexResolution`, whose cache holds a live adapter bound to a binary path: that cache
  // is for EXECUTION, and borrowing it for disclosure is what pinned the codex row too.
  //
  // gh is GONE from this line (v4.2): GitHub is an account (the device sign-in), not a CLI to
  // detect here. The line covers harnesses only; `forge.detect` covers the forge CLIs.
  function detectHarnesses(): Promise<DetectedHarness[]> {
    return shareHarnessDetection(async (): Promise<DetectedHarness[]> => {
      // `RENNET_DISABLE_HARNESS` disables the whole line, not just claude — the per-host path
      // already reads it that way, and a flag named "disable harness" that still reported
      // codex was disclosing something the operator had switched off.
      if (env.RENNET_DISABLE_HARNESS === "1") return [];
      const [claude, codex] = await Promise.all([
        discoverClaude(defaultDiscoveryDeps(), CLAUDE_TESTED_RANGE).catch(() => null),
        discoverCodex(defaultCodexDiscoveryDeps(), {}).catch(() => null),
      ]);
      const detected: DetectedHarness[] = [];
      if (claude?.chosen) detected.push({ id: "claude", version: claude.chosen.version });
      if (codex?.chosen) detected.push({ id: "codex", version: codex.chosen.version ?? null });
      return detected;
    });
  }

  // Per-host agent detection (C17 cluster 3, #485) — the server-side fan-out behind
  // `harness.hosts`. The client holds ONE daemon connection, so THIS daemon asks each host
  // the only way it CAN be asked, and answers `null` for a host it cannot ask at all:
  //
  //  • `local` — this process runs on that host; the memoized ambient detection IS the answer.
  //  • `wsl:<distro>` — the distro's OWN discovery deps (login-shell PATH + curated dirs +
  //    `<path> --version`, every probe entering the distro through `wsl.exe`), so the rows are
  //    the distro's binaries, never the host's. The distro is first asked for its login-shell
  //    PATH: no answer ⇒ `wsl.exe` cannot enter it, so the host is UNASKED (`null`) rather than
  //    reported as having no agents. The answer is reused, so this costs no extra spawn.
  //  • `remote:<deviceId>` — a paired device DIALS this daemon; nothing here can dial back to
  //    run a probe on it. `null` — honestly unasked, never this machine's agents copied over.
  //
  // Shared per host WHILE IN FLIGHT, never cached past it (C17 review finding 2): the probes
  // spawn a login shell and the settings surface re-reads on every toggle, so concurrent
  // readers join one probe — but an agent installed in a distro shows up on the next read.
  function detectHarnessesOn(source: ProjectSource): Promise<DetectedHarness[] | null> {
    if (source === "local") return detectHarnesses();
    if (!source.startsWith("wsl:")) return Promise.resolve(null);
    const distro = source.slice("wsl:".length);
    return shareHarnessDetectionByHost(source, async (): Promise<DetectedHarness[] | null> => {
      if (env.RENNET_DISABLE_HARNESS === "1") return [];
      // A distro whose `$HOME` cannot be probed cannot be entered at all, and
      // `wslDiscoveryDeps` now THROWS rather than substituting `/root` — so the host reads
      // unasked instead of being scanned against a home that is not its own.
      const distroDeps = await wslDiscoveryDeps(distro).catch(() => null);
      if (!distroDeps) return null;
      const loginShellPath = await distroDeps.loginShellPath();
      if (loginShellPath === null) return null; // the distro could not be entered.
      const deps: DiscoveryDeps = { ...distroDeps, loginShellPath: async () => loginShellPath };
      const [claude, codex] = await Promise.all([
        discoverClaude(deps, CLAUDE_TESTED_RANGE).catch(() => null),
        discoverCodex(deps, {}).catch(() => null),
      ]);
      const detected: DetectedHarness[] = [];
      if (claude?.chosen) detected.push({ id: "claude", version: claude.chosen.version });
      if (codex?.chosen) detected.push({ id: "codex", version: codex.chosen.version ?? null });
      return detected;
    });
  }

  // Forge (source-control) CLI detection (C17, #483 gh rides again). Same disclosure model as
  // detectHarnesses, including its liveness: shared while the probe runs, never cached past
  // it, so installing `gh` — or signing in with it — shows up on the next read instead of
  // after a restart. Singleton registry — GitHub / `gh` only. Feeds `sourceControlByHost`.
  function detectForges(): Promise<DetectedForge[]> {
    return shareForgeDetection(() =>
      runForgeDetection(defaultForgeDetectionDeps()).catch(() => []),
    );
  }

  // Per-host forge detection (C17 amendment B) — the exact mirror of `detectHarnessesOn`, so a
  // WSL card shows the DISTRO's own `gh` (and its own auth state) instead of a Source Control
  // section it is structurally incapable of filling. `local` is the memoized ambient answer;
  // `wsl:<distro>` runs the whole probe chain inside the distro (a distro `wsl.exe` cannot
  // enter reports UNASKED, never "no gh"); a paired `remote:` device dials US, so it cannot be
  // probed at all. Shared per host while in flight, never cached past it — the same liveness
  // as the agent probe, for the same reason.
  function detectForgesOn(source: ProjectSource): Promise<DetectedForge[] | null> {
    if (source === "local") return detectForges();
    if (!source.startsWith("wsl:")) return Promise.resolve(null);
    const distro = source.slice("wsl:".length);
    return shareForgeDetectionByHost(source, async (): Promise<DetectedForge[] | null> => {
      // Same rule as the agent probe: an unprobeable `$HOME` throws, so the host reads
      // unasked rather than being scanned against a fabricated home.
      const distroDeps = await wslForgeDetectionDeps(distro);
      const loginShellPath = await distroDeps.loginShellPath();
      if (loginShellPath === null) return null; // the distro could not be entered.
      return runForgeDetection({ ...distroDeps, loginShellPath: async () => loginShellPath });
    }).catch(() => null);
  }

  /**
   * UPDATE one host's daemon (C17 cluster 6, #534) — the effect behind Update Daemon, offered
   * only where `daemon.status` reported a real `updateAvailable`. Exactly one host kind has an
   * update mechanism, and the others say why rather than pretending:
   *
   *  • `wsl:<distro>` — `ensureWslDaemon` IS the mechanism: it delivers THIS shell's server
   *    bundle into the distro and, for a version-skew daemon, stops the old one by the pid its
   *    identity carries before spawning the current bundle. The identity it returns names the
   *    version now running, so the card reads an observed number, never an assumed one.
   *  • `local` — this daemon ships with the Rennet app; updating it means updating the app.
   *  • `remote:<deviceId>` — that device runs its own Rennet and updates itself.
   */
  async function updateDaemonForHost(source: ProjectSource): Promise<{ version: string | null }> {
    if (source === "local") {
      throw new Error(
        "This machine's daemon ships with the Rennet app — update Rennet to update it.",
      );
    }
    if (!source.startsWith("wsl:")) {
      throw new Error("A paired device runs its own Rennet; update it from that device.");
    }
    if (!options.hostBundlePath) {
      throw new Error(
        "This Rennet daemon has no server bundle to deliver, so it cannot update a WSL daemon.",
      );
    }
    const handle = await ensureWslDaemon(source.slice("wsl:".length), {
      serverVersion,
      hostBundlePath: options.hostBundlePath,
      run: createWslRunner(),
    });
    return { version: handle.identity.version };
  }

  // ── The GitHub egress composition (issue #21, v4.2 device flow) ──────────────
  // The outbound HTTP is injected by the shell (the app owns the transport), so no
  // code here holds a raw socket. The bearer is the STORED token — minted by the
  // OAuth device flow or pasted as a PAT, kept in the daemon's 0600 token file —
  // resolved LAZILY on the FIRST real egress, never at launch and never for a
  // dry-run (which constructs the request without a credential).
  // Connect-phase resilience: one retry on a momentary network blip, and a
  // plain-language error (never a raw undici internal) when GitHub is unreachable.
  // Every request ALSO carries an abort deadline (the lancelot field bug: a
  // stalled connection to api.github.com hung auth validation forever, which
  // wedged `project.detail` AND the account surface). The deadline wraps OUTSIDE
  // the retry: ONE absolute budget spans both attempts, so a slow connect
  // failure plus the retry pause plus a stalled second attempt can never chain
  // past the deadline — the retry gets the REMAINDER, which is the honest
  // contract. The pause itself is abort-aware, and a deadline abort
  // (TimeoutError — not a connect-phase code) is never replayed. One composition
  // here bounds every consumer — validation, the refresh exchange, the PR
  // source, the device flow (whose cancel signal stays composed in), and
  // publish — so the worst network case is a bounded failure the rejection
  // paths below already recover from.
  const rawGitHubHttp: typeof globalThis.fetch =
    options.httpFetch ??
    (() => Promise.reject(new Error("Rennet server: options.httpFetch was not provided")));
  const publishHttp: typeof globalThis.fetch = composeGitHubTransport(
    rawGitHubHttp,
    options.httpTimeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS,
  );

  const gitHubSecretStore = createGitHubTokenStore(dataDir);
  /** An UNAUTHENTICATED client for validation; candidate tokens ride as headers. */
  const bareOctokit = createGitHubOctokit({ fetch: publishHttp });
  // Only the refresh EXCHANGE runs under the account lock (rotation is
  // session-fatal when concurrent); validation runs outside it, so a hung GitHub
  // request can never block a disconnect or an authorized flow's store.
  const resolveAuth = () =>
    resolveGitHubAuth({
      octokit: bareOctokit,
      secretStore: gitHubSecretStore,
      refresh: (refreshToken) => refreshGitHubCredential({ fetch: publishHttp, refreshToken }),
      withLock: withAccountLock,
      // One single-line, secret-free `[github-auth]` record per refresh observation
      // to the daemon's stdout (captured to daemon.log) — so a field refresh
      // failure is read off the log, not inferred. RefreshLogRecord carries no
      // token/secret field, so nothing here can leak a credential.
      log: (record) => {
        const parts = [`phase=${record.phase}`];
        if (record.githubError !== undefined) parts.push(`githubError=${record.githubError}`);
        if (record.tokenKind !== undefined) parts.push(`tokenKind=${record.tokenKind}`);
        console.log(`[github-auth] ${parts.join(" ")}`);
      },
    });

  /** Resolve the GitHub bearer for a real egress; throws (never posts) when unavailable. */
  async function resolveGitHubAuthOk() {
    const auth = await resolveAuth();
    if (!auth.ok) throw new Error(`GitHub authentication is unavailable (${auth.reason})`);
    return auth;
  }

  /** When an auth-derived memo must die: the credential's own expiry, minus skew. */
  function memoDeadline(expiresAt: string | null): number | null {
    if (!expiresAt) return null;
    const parsed = Date.parse(expiresAt);
    return Number.isNaN(parsed) ? null : parsed - 60 * 1000;
  }

  // A token-bound Octokit for a real egress, memoized so a multi-page publish does
  // not re-validate (`/rate_limit` + `/user`) per request. Invalidated whenever the
  // account changes AND when the underlying token nears its own expiry — an
  // expiring-token app rotates every 8 hours, and a memo that outlives the token
  // would 401 forever without ever consulting the refresh path. A failed
  // resolution is never cached.
  interface OctokitMemo {
    promise: Promise<Octokit>;
    deadline: number | null;
  }
  let octokitMemo: OctokitMemo | null = null;
  async function resolveGitHubOctokit(): Promise<Octokit> {
    if (octokitMemo && octokitMemo.deadline !== null && Date.now() > octokitMemo.deadline) {
      octokitMemo = null;
    }
    octokitMemo ??= (() => {
      const memo: OctokitMemo = {
        promise: resolveGitHubAuthOk().then((auth) => {
          if (octokitMemo === memo) memo.deadline = memoDeadline(auth.expiresAt);
          return createGitHubOctokit({ fetch: publishHttp, token: auth.token });
        }),
        deadline: null,
      };
      return memo;
    })();
    const memo = octokitMemo;
    try {
      return await memo.promise;
    } catch (error) {
      if (octokitMemo === memo) octokitMemo = null;
      throw error;
    }
  }

  // Account mutations (device-flow store, paste, disconnect) are SERIALIZED so a
  // flow completing mid-disconnect cannot interleave with the token file write and
  // resurrect a token the user just forgot.
  let accountLock: Promise<unknown> = Promise.resolve();
  function withAccountLock<T>(mutate: () => Promise<T>): Promise<T> {
    const next = accountLock.then(mutate, mutate);
    accountLock = next.catch(() => undefined);
    return next;
  }

  // The live project-detail PR source (issue #37, B2). Resolved from the SAME stored
  // token as egress, memoized so `project.detail` never re-validates per call. When
  // auth is unavailable it stays `null` and `project.detail` degrades to the local-only
  // list (B1) — a missing token is a local-only surface, never a failed fetch rendered
  // as "zero PRs". Resolution is lazy (first `project.detail`), never at launch —
  // INVALIDATED on connect/paste/disconnect so the surface follows the account, and
  // a distinct auth-unavailable REASON rides along so the detail screen can say
  // WHICH problem stands between the user and the PR half.
  interface ProjectPrResolution {
    source: ProjectPrSource | null;
    authUnavailable?: "not-connected" | "token-invalid" | "insufficient-scope" | "network";
  }
  let projectPrMemo: { promise: Promise<ProjectPrResolution>; deadline: number | null } | null =
    null;
  async function resolveProjectPrSource(): Promise<ProjectPrResolution> {
    // Expiry-aware, like octokitMemo: a PR source bound to an 8-hour token must
    // re-resolve (and thereby refresh) once that token nears its end.
    if (projectPrMemo && projectPrMemo.deadline !== null && Date.now() > projectPrMemo.deadline) {
      projectPrMemo = null;
    }
    projectPrMemo ??= (() => {
      const memo: { promise: Promise<ProjectPrResolution>; deadline: number | null } = {
        promise: Promise.resolve({ source: null }),
        deadline: null,
      };
      memo.promise = (async (): Promise<ProjectPrResolution> => {
        let auth: Awaited<ReturnType<typeof resolveAuth>>;
        try {
          auth = await resolveAuth();
        } catch {
          // `resolveGitHubAuth` classifies transport failures as the honest
          // `network` reason itself, so only a NON-network fault lands here
          // (store corruption, a broken response). Degrade to the local-only
          // list rather than failing the whole project.detail RPC; the memo is
          // cleared so the next call retries.
          if (projectPrMemo === memo) projectPrMemo = null;
          return { source: null };
        }
        if (!auth.ok) return { source: null, authUnavailable: auth.reason };
        // Unconditional: this is OUR memo record; if it was already replaced, the
        // stale record is unreachable and the write is harmless.
        memo.deadline = memoDeadline(auth.expiresAt);
        return {
          source: createGitHubProjectPrSource({
            octokit: createGitHubOctokit({ fetch: publishHttp, token: auth.token }),
          }),
        };
      })();
      return memo;
    })();
    // A transient validation failure must not poison the memo (mirrors octokitMemo):
    // the next project.detail retries instead of failing forever.
    const memo = projectPrMemo;
    try {
      const resolved = await memo.promise;
      // An unreachable GitHub is transient: memoizing the verdict would pin the
      // surface local-only after the network recovers. The next call retries.
      if (resolved.authUnavailable === "network" && projectPrMemo === memo) {
        projectPrMemo = null;
      }
      return resolved;
    } catch (error) {
      if (projectPrMemo === memo) projectPrMemo = null;
      throw error;
    }
  }

  /** Drop every memoized auth-derived surface (the account changed). */
  function invalidateGitHubMemos(): void {
    projectPrMemo = null;
    octokitMemo = null;
  }

  /** The renderer-safe projection of the host auth state (the token never leaves). */
  function projectAuthStatus(auth: Awaited<ReturnType<typeof resolveAuth>>): GitHubAuthStatus {
    if (auth.ok) return { state: "connected", login: auth.login, scopes: auth.scopes };
    if (auth.reason === "insufficient-scope") {
      return { state: "insufficient-scope", copy: auth.copy, scopes: auth.scopes };
    }
    return { state: auth.reason, copy: auth.copy };
  }

  // ── The one-time device-flow connect (v4.2) ──────────────────────────────────
  // One in-flight flow at a time: `connectStart` mints the device code (replacing
  // any previous flow), the background poll stores the token on authorize, and the
  // renderer polls `connectPoll` until connected/failed. Cancel aborts the poll.
  let deviceFlow: {
    controller: AbortController;
    outcome: GitHubConnectPoll;
  } | null = null;
  const githubAccount = {
    async status(): Promise<GitHubAuthStatus> {
      return projectAuthStatus(await resolveAuth());
    },
    async connectStart() {
      deviceFlow?.controller.abort();
      const controller = new AbortController();
      const flow: NonNullable<typeof deviceFlow> = {
        controller,
        outcome: { phase: "pending" },
      };
      deviceFlow = flow;
      const verification = await new Promise<{
        user_code: string;
        verification_uri: string;
      }>((resolveVerification, rejectVerification) => {
        runGitHubDeviceFlow({
          fetch: publishHttp,
          signal: controller.signal,
          onVerification: resolveVerification,
        })
          .then(async (minted) => {
            // Generation guard: a flow that was cancelled, replaced, or raced by a
            // disconnect must NOT store its credential — the user has moved on.
            const stored = await withAccountLock(async () => {
              if (deviceFlow !== flow) return false;
              await gitHubSecretStore.setGitHubCredential(minted);
              invalidateGitHubMemos();
              return true;
            });
            if (!stored) return;
            flow.outcome = { phase: "connected", status: projectAuthStatus(await resolveAuth()) };
          })
          .catch((error: unknown) => {
            // A deliberate cancel aborts the in-flight fetch too, which would
            // otherwise read as AbortError = "network". The user's own cancel is
            // never a connectivity problem — report it as what it is, quietly.
            const cancelled = controller.signal.aborted;
            // Raw undici strings ("UND_ERR_CONNECT_TIMEOUT…") are not user copy:
            // map a network failure to plain words, keep the raw detail in the log.
            const network = !cancelled && isGitHubNetworkError(error);
            if (network) console.warn("GitHub device flow could not reach github.com", error);
            const message = network
              ? "Couldn't reach github.com — check your connection."
              : String((error as Error)?.message ?? error);
            flow.outcome = { phase: "failed", message };
            rejectVerification(network ? new Error(message) : error);
          });
      });
      return {
        userCode: verification.user_code,
        verificationUri: verification.verification_uri,
      };
    },
    async connectPoll(): Promise<GitHubConnectPoll> {
      return deviceFlow?.outcome ?? { phase: "idle" };
    },
    async connectCancel(): Promise<void> {
      deviceFlow?.controller.abort();
      deviceFlow = null;
    },
    async setToken(token: string): Promise<GitHubAuthStatus> {
      // The side door: validate BEFORE storing — a bad paste persists nothing.
      // A PAT has no refresh half; the credential is the token alone.
      const state = await validateGitHubToken(token, { octokit: bareOctokit });
      if (state.ok) {
        await withAccountLock(async () => {
          await gitHubSecretStore.setGitHubCredential({ token });
          invalidateGitHubMemos();
        });
      }
      return projectAuthStatus(state);
    },
    async disconnect(): Promise<void> {
      deviceFlow?.controller.abort();
      deviceFlow = null;
      await withAccountLock(async () => {
        await gitHubSecretStore.setGitHubCredential(null);
        invalidateGitHubMemos();
      });
    },
  };

  const allowedRoots = new Set<string>();
  // Proactive Repo Map rehydration (#143/#243): keeps each built project's structural
  // snapshot and model-backed knowledge warm as its reference branch advances.
  // Assigned in `whenReady`, torn down on quit.
  let rehydration: ProactiveRehydration | null = null;
  // The loopback WS listener (#378), assigned once dispatch exists (below). The
  // rehydration broadcast and shutdown reference it through this binding; both run
  // after construction, by which time it is set.
  let wsListener: WsListener | null = null;
  // The in-flight conversation turns (#251, criterion 4). One registry for the app
  // lifetime: dispatch registers each `review.ask` turn's AbortController and settles
  // it when the turn finishes; `before-quit` aborts whatever is still in flight so a
  // model child is asked to stop rather than surviving the quit.
  const liveTurns = new LiveTurnRegistry();
  function activePatchset(review: Review): Patchset {
    const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
    if (!patchset) throw new Error("The active patchset is missing");
    return patchset;
  }

  /** The repository picker: the test-repo env (e2e) or the Electron directory dialog. */
  async function chooseRepository(): Promise<string | null> {
    const testPath = env.RENNET_TEST_REPO;
    if (testPath) return testPath;
    return options.chooseRepositoryFallback ? options.chooseRepositoryFallback() : null;
  }

  /**
   * Resolve the local clone a PR review works from (clone-on-demand, #225). A
   * supplied path that IS a clone of the PR's repo wins (the project row's own path,
   * or an explicit directory pick); anything else — no path, a non-repo path, a
   * clone of some other repo — resolves the managed blobless clone under the app
   * data dir, creating it on first use. Identity matching (owner/name vs the repo's
   * remotes) decides, never a path-name guess.
   */
  async function resolvePrRepoRoot(
    prRef: NonNullable<ReturnType<typeof parseGitHubPrRef>>,
    repoPath: string | undefined,
  ): Promise<string> {
    if (repoPath) {
      try {
        const worktree = await discoverWorktreeIdentities(gitForRepo(repoPath), repoPath);
        if (matchWorktree(prRef.repo, [worktree])) return repoPath;
      } catch {
        // Not a git repo at all — fall through to the managed clone.
      }
    }
    return ensureManagedClone(dataDir, prRef.repo);
  }

  /** The review → PR-worktree index (a plain JSON file under the data dir). */
  const prWorktreeIndexPath = join(dataDir, "pr-worktrees.json");
  function readPrWorktreeIndex(): Record<string, { path: string }> {
    try {
      return JSON.parse(readFileSync(prWorktreeIndexPath, "utf8")) as Record<
        string,
        { path: string }
      >;
    } catch {
      return {};
    }
  }
  function recordPrWorktree(reviewId: string, path: string): void {
    const index = readPrWorktreeIndex();
    index[reviewId] = { path };
    writeFileSync(prWorktreeIndexPath, JSON.stringify(index));
  }

  /**
   * The GitHub PR front door (issue #37/#20 flow, User Journey stage 2). Parse the
   * ref, resolve a clone (the supplied path when it matches, the managed blobless
   * clone otherwise — clone-on-demand, #225), deep-fetch the PR (GitHub owns
   * identity), pin its OIDs, diff the range locally (git owns content), and persist
   * a review. After the review lands, a detached worktree at the reviewed head OID
   * is ensured (an executable checkout — retrospective included) and the repo's
   * `.rennet/setup` commands run in it, fire-and-forget: setup never blocks or
   * fails the review.
   *
   * `retrospective` opens the review read-only over an already-merged (or any) PR:
   * the diff is still the git range base..head from history (a merged PR needs no
   * "PR must be open" assumption), but the created review is flagged so MAIN refuses
   * egress and the renderer hides the sign affordance. The open path is otherwise
   * identical — one engine, one changeset source.
   */
  async function openPullRequest(
    commandId: string,
    ref: string,
    repoPath: string | undefined,
    retrospective: boolean,
  ): Promise<Review> {
    const prRef = parseGitHubPrRef(ref);
    if (!prRef) {
      throw new Error(`"${ref}" is not a pull request. Use owner/repo#123 or a GitHub PR URL.`);
    }
    const root = await resolvePrRepoRoot(prRef, repoPath);
    const forge = new GitHubForgeAdapter({ octokit: await resolveGitHubOctokit() });
    const locus = locusForRepo(root);
    const gitInLocus = gitForRepo(root);
    const source = new GitHubChangesetSource({
      forge,
      git: gitInLocus,
      locus,
      pin: createRefPinner(gitInLocus),
      // The candidate set is the single resolved clone. Identity matching
      // (owner/name vs the repo's remotes) decides whether it is the right clone;
      // it never falls back to a path-name guess.
      worktrees: { list: async () => [await discoverWorktreeIdentities(gitInLocus, root)] },
      resolveProjectSnapshotId: (repoRoot, baseOid) =>
        ensureProjectSnapshotPin(liveSnapshotStore, repoRoot, baseOid, gitInLocus),
    });
    const result = await source.open(prRef);
    if (!result.pin) {
      // Defensive: the root was resolved by identity above, so a null pin should be
      // unreachable — but never continue into a lying degraded state silently.
      throw new Error(
        `Could not open ${prRef.repo.owner}/${prRef.repo.name}#${prRef.number} from a local clone.`,
      );
    }
    // Stamp the REAL post-target onto the review (issue #21) so the renderer can post
    // this exact PR AS THE USER on a hold-to-sign — the repo, PR number, the forge's
    // opaque node id (`forgeRef`), and the reviewed head OID. A RETROSPECTIVE review
    // gets NO target (nothing may be posted): `createReviewFromPatchset` also drops it
    // defensively, and this is the honest producer half.
    const pr = result.pullRequest;
    const postTarget = retrospective
      ? undefined
      : {
          repo: { forge: pr.ref.repo.forge, owner: pr.ref.repo.owner, name: pr.ref.repo.name },
          number: pr.ref.number,
          forgeRef: pr.forgeRef,
          headOid: pr.headOid,
          // The ownership fact (GraphQL `viewerDidAuthor`): an OWN PR routes the
          // own-branch lane, a teammate's routes Post-review. Sourced honestly from
          // the same authenticated PR fetch, not re-derived on the client.
          viewerDidAuthor: pr.viewerDidAuthor,
        };
    const review = await service.createReviewFromPatchset(commandId, result.patchset, {
      retrospective,
      ...(postTarget ? { postTarget } : {}),
    });
    // A worktree per reviewed PR at the pinned head (an executable past for the
    // agent to run tests in). A superseded head replaces the old checkout. Failure
    // here never blocks the review — the diff and conversation need no checkout.
    try {
      const worktree = prWorktreePath(dataDir, prRef.repo, prRef.number);
      const { created } = await ensurePrWorktree(gitInLocus, root, worktree, pr.headOid);
      recordPrWorktree(review.id, worktree);
      if (created) {
        // Fire-and-forget; the runner itself records a failed verdict, and an
        // unexpected crash must not become an unhandled rejection.
        void runPrWorktreeSetup(worktree).catch(() => undefined);
      }
    } catch {
      // No worktree: `review.prWorktree` honestly returns null.
    }
    return review;
  }

  /**
   * Review a local BRANCH (#587) — the New Chat row click's engine. The reviewer clicks
   * `feat/x`; we resolve its head OID and `git merge-base <base> <head>`, then take the
   * `base...head` range through the SAME `captureRangePatchset` the PR source uses.
   *
   * Nothing is checked out and the working tree is never touched, so — exactly like a PR
   * review — this is a SNAPSHOT of pinned OIDs. That is why the source is `local-branch`
   * and not `local`: `local` means the working-tree capture, and the renderer keys its
   * freshness watcher and Regenerate on exactly that. Calling a branch range `local` would
   * hand Regenerate a licence to replace the reviewed range with a capture of this clone's
   * tree — a lie and a destroyed artifact, the same trap `review.openPr` documents.
   *
   * `headRef` is carried into provenance, so the round path's read-only session lookup
   * resolves this review onto the session that claimed the branch.
   *
   * A branch with no unique commits (already merged, or identical to base) has
   * `merge-base == head`, so the range is empty and the review is honestly empty — never
   * a failed click.
   */
  /**
   * WHICH repo of a project a row's `owner/name` names (#587). A workspace maps MANY repo
   * roots to ONE project identity and the mapping is not invertible, so `Project.openPath`
   * — "the repo, or the FIRST included repo" — answers the wrong question for every row
   * that is not the first repo's. The row carries an identity and never a path (R19), so
   * the resolution has to happen here, where the included roots are known.
   *
   * `undefined` when nothing matches: a caller falls back to the project path, which is the
   * pre-existing behaviour and correct for a single-repo project.
   */
  async function repoRootForIdentity(
    project: Project | undefined,
    identity: string,
  ): Promise<string | undefined> {
    if (!project) return undefined;
    const roots = [
      ...new Set([...(project.includedRepoPaths ?? []), project.openPath, project.path]),
    ].filter((root) => root.length > 0);
    for (const root of roots) {
      if ((await repositoryIdentity(gitForRepo(root), root)) === identity) return root;
    }
    return undefined;
  }

  async function captureBranch(
    commandId: string,
    repoPath: string,
    head: string,
    base: string,
  ): Promise<Review> {
    const locus = locusForRepo(repoPath);
    const git = gitForRepo(repoPath);
    const patchset = await captureBranchPatchset({
      git,
      locus,
      repoPath,
      head,
      base,
      resolveProjectSnapshotId: (root, baseOid) =>
        ensureProjectSnapshotPin(liveSnapshotStore, root, baseOid, git),
    });
    return service.createReviewFromPatchset(commandId, patchset);
  }

  /**
   * Source the per-project convention / anti-pattern catalogue (#180) for a review
   * from `<repositoryRoot>/.rennet/conventions.json`. Honest degradation: an absent,
   * unreadable, empty, or all-malformed file yields `undefined` and every lens runs
   * exactly as before — the catalogue is threaded into the runners ONLY when at
   * least one valid rule was found. Read once per lens command (a small JSON file),
   * matching each command's existing self-contained setup (its own decompose +
   * manifest + budget).
   */
  function loadReviewConventions(review: Review): ConventionCatalogue | undefined {
    return loadConventionCatalogue(review.repositoryRoot).catalogue;
  }

  function reportContextFeedError(error: unknown): void {
    console.error("Context feed transcript persistence failed", error);
  }

  function recordedDesktopSeatTurn(
    runTurn: (prompt: string, attempt: number) => Promise<HarnessTurnResult>,
    seat: string,
    feed: ReviewContextFeed,
  ): (prompt: string, attempt: number) => Promise<HarnessTurnResult> {
    return guardSeatTurn(
      recordSeatSend(runTurn, { seat, harness: "claude-code" }, feed.onSend, feed.assembledContext),
    );
  }

  /**
   * The live Flagged lens runner (issue #32/#138 + dual-model #41), replacing
   * `flaggedReviewFixture`. Decomposes the review's active patchset into the offered
   * hunk manifest and runs the finding lens on the user's installed provider seats,
   * budget-gated. The result becomes the lens's `FlaggedReview` behind the SAME
   * `flagged.review` boundary — the UI is unchanged.
   *
   *   • DEEP/DUAL review (`deepReview` true) is the DEFAULT (Rai's mandate, 2026-08-11)
   *     with two providers installed → the SAME finding lens runs INDEPENDENTLY on a
   *     Claude seat and a Codex seat, and the two grounded sets are reconciled into
   *     agreement/disagreement (#41) — never averaged. If the Codex seat is unavailable
   *     or errors it degrades to the single seat with an honest "second seat
   *     unavailable" marker (never a fabricated concurrence). Per-finding verification
   *     (#179) also runs by default under this same flag.
   *   • QUICK review (`deepReview` explicit false) is the manual OPT-DOWN → ONE Claude
   *     seat: each finding keeps its honest `concur 1/1`, no `dual` note, no verification.
   *
   * With no discoverable provider, or on a total runner failure/budget refusal, the
   * lens gets the LOUD `failed` state — "ran clean" is never faked from "did not run".
   */
  async function runFlaggedReviewWithContextFeed(
    review: Review,
    deepReview: boolean,
    session: ReviewIntelligenceSession,
  ): Promise<FlaggedReviewRun> {
    const patchset = activePatchset(review);
    const { locus, distroCwd } = locusContextForRepo(review.repositoryRoot);
    const { adapter } = await getClaudeHarness(locus, distroCwd);
    const sharedBudget = session.budget;
    const codexResolution = await getCodexResolution(locus);
    const codex = codexResolution.availability;
    const decomposition = decompose(patchset);
    const manifest = buildOfferedManifest(decomposition);

    // The honestly-probed installed set (drives the CI-classification seat below).
    const installed: CouncilHarnessId[] = [];
    if (adapter) installed.push("claude-code");
    if (codex.available) installed.push("codex");

    const ciAssignment = resolveAssignment("ci-failure-classification", {
      availability: { installed },
    });
    // The Codex leg roots at the repository, like the Claude leg right below it (W5).
    const codexUtilityExecutor = codexResolution.makeExecutor?.(distroCwd ?? review.repositoryRoot);
    const ciRefinementTurn =
      ciAssignment.kind !== "model"
        ? undefined
        : ciAssignment.harness === "codex" && codexUtilityExecutor
          ? createCodexCiRefinementTurn(codexUtilityExecutor, {
              model: ciAssignment.model,
              effort: ciAssignment.effort,
            })
          : ciAssignment.harness === "claude-code" && adapter
            ? createClaudeCiRefinementTurn(adapter, {
                cwd: review.repositoryRoot,
                model: ciAssignment.model,
              })
            : undefined;

    // The model finding generator (the dual-seat `runFindingAngle` path) died with
    // the Board rebuild (#489); B8's drafters replace it. Until then the flagged lens
    // degrades to no findings — the deterministic CI signal, incomplete-ingestion
    // blocking states, and $0 UI-surface classifier below still stamp the honest
    // render-only chrome, and deep-review verification simply has nothing to verify.
    const flagged: FlaggedReview = { status: "ok", findings: [] };

    // ── Per-finding verification (#179): a DEEP-REVIEW feature, alongside dual-model ──
    // Quick review stays single-Claude with NO verification (byte-identical to before).
    // In deep review, reproduce-or-refute each non-obvious finding against the REAL file
    // content: a refuted finding is dropped, the rest carry an evidence chip. The reader
    // (#206, createVerificationFileReaderForPatchset) selects working-tree vs
    // git-show-at-head by the patchset's captured surface, so verification reads the
    // right bytes for working-tree AND PR/retrospective reviews. Absent a Claude adapter
    // there is no verification seat (createVerificationTurn needs a HarnessPort) — but in
    // DEEP review that absence must ANNOUNCE itself (P0-3, below), never surface a chipless
    // finding that reads as "nothing to check."
    let surfacedReview: FlaggedReview;
    if (deepReview && adapter) {
      const readFileWindow = createVerificationFileReaderForPatchset({
        patchset,
        hunks: decomposition.hunks,
        git: gitForRepo(patchset.repository.root),
      });
      const runTurn = createVerificationTurn(adapter, { cwd: review.repositoryRoot });
      // BUDGET-GATE (Rule 75, vital money circuit): `maxVerifications` caps how many
      // findings are verified — the over-cap remainder surfaces an honest "not verified"
      // caveat chip (CAP_CAVEAT), NEVER a silent skip that would read as an all-clear —
      // and the invocation budget bounds actual model turns (one per finding,
      // with a visible refusal floor). Both limits surface on the findings themselves; the returned
      // telemetry is the aggregate of those same per-finding chips, so no capped or
      // refused finding is dropped without a visible caveat.
      const { review: verified } = await verifyFlaggedReview(flagged, {
        manifest,
        readFileWindow,
        runTurn,
        budget: sharedBudget,
        maxVerifications: DEFAULT_REVIEW_INTELLIGENCE_BUDGET.verification.maxVerifications,
      });
      // The predicted-risk cross-check (#181), the LAST transform. Deterministic, $0 —
      // absent a hypothesis it returns the review unchanged.
      surfacedReview = attachRiskCrossCheck(verified, undefined);
    } else {
      // Reaching here under DEEP review means there is no Claude verifier (e.g. a
      // Codex-only review). Announce that honestly: every finding that WOULD have been
      // verified gets an explicit unavailable caveat. Quick review stays unchanged
      // because it never promised verification. The cross-check is a free deterministic
      // step over whichever honest surface applies.
      const surfaced = projectUnavailableDeepVerification(flagged, deepReview);
      surfacedReview = attachRiskCrossCheck(surfaced, undefined);
    }

    const withCiSignal = await attachCiSignal({
      review: surfacedReview,
      ...(review.postTarget === undefined ? {} : { postTarget: review.postTarget }),
      patchset,
      manifest,
      fetchCiStatus: async (ref, headOid, signal) =>
        new GitHubForgeAdapter({ octokit: await resolveGitHubOctokit() }).fetchCiStatus(
          ref,
          headOid,
          signal,
        ),
      ...(ciRefinementTurn === undefined ? {} : { refineTurn: ciRefinementTurn }),
      budget: sharedBudget,
    });
    // R18/#309: stamp the deterministic incomplete-ingestion blockers from the
    // decomposition we already computed — ok and failed alike (blocked ingestion is
    // deterministic, not a model result, so it survives a failed model run). The
    // Flagged lens + PublishSheet disclose it as render-only honest copy; it NEVER
    // gates the sign (Rule Zero). Mirrors the #160 patchsetId stamp.
    const stamped = stampBlockingStates(withCiSignal, decomposition);
    // The deterministic UI-surface classifier is $0 and records the honest immediate
    // status (not-ui / pending / verifier-unavailable). The live verify-ui model turn
    // and the cross-harness adjudication turn are gone with the Board rebuild (B2), so
    // no late enrichment is scheduled — the immediate rows are the whole result.
    const uiClassification = classifyUiSurface(patchset.files);
    const immediate = applyImmediateUiVerification(stamped, {
      touchesUi: uiClassification.touchesUi,
      classifierVersion: uiClassification.version,
      deepReview,
      verifierAvailable: Boolean(adapter),
    });
    const composed = composeFlaggedLateEnrichment({
      immediate,
      adjudication: null,
      uiVerification: null,
    });
    return { review: composed.review, adjudication: composed.enrichment };
  }

  async function runFlaggedReview(
    review: Review,
    deepReview: boolean,
    session: ReviewIntelligenceSession,
  ): Promise<FlaggedReviewRun> {
    const contextFeed = await createDesktopReviewContextFeed(review, {
      onError: reportContextFeedError,
    });
    const completed = await runWithReviewContextFeed(contextFeed, () =>
      runFlaggedReviewWithContextFeed(review, deepReview, session),
    );
    return completed.result;
  }

  /**
   * The live requirement→hunk coverage producer (Rai, wireframes #9 / R53), behind the
   * `openspec.coverage` boundary. Reads the review's OpenSpec change, decomposes the
   * active patchset into the offered hunks, and runs the coverage-mapping turn on the
   * user's `claude` seat, budget-gated — grounding each requirement to the offered hunks
   * that implement it (any hallucinated hunk dropped) and completing every requirement,
   * so `ok` yields covered-or-honest-zero per requirement. NO change ⇒ `null` (no chips).
   * NO adapter, a budget refusal, or a failed turn ⇒ `status: "failed"` with no edges
   * (the Spec view renders no chips) — an uncomputed mapping never becomes a fake zero.
   */
  async function runLiveCoverage(review: Review): Promise<OpenSpecCoverage | null> {
    const patchset = activePatchset(review);
    const change = await readOpenSpecChange(patchset, gitForRepo(patchset.repository.root));
    if (!change) return null;

    // The requirements are the authority — the producer iterates and completes them, so
    // the model can neither invent a requirement nor silently drop one.
    const requirements = change.specDeltas.flatMap((delta) =>
      delta.groups.flatMap((group) =>
        group.requirements.map((requirement) => ({
          capability: delta.capability,
          name: requirement.name,
          statement: requirement.statement,
          scenarios: requirement.scenarios.map((scenario) => scenario.name),
        })),
      ),
    );
    // No requirements ⇒ an honest empty OK (nothing to map, no chips).
    if (requirements.length === 0) return { status: "ok", edges: [] };

    const { locus, distroCwd } = locusContextForRepo(review.repositoryRoot);
    const { adapter } = await getClaudeHarness(locus, distroCwd);
    // No model seat ⇒ cannot compute; honest failed (no chips), never a fabricated zero.
    if (!adapter) return { status: "failed", edges: [] };

    // The offered hunks (the model may cite ONLY these; the runner grounds against them).
    // KNOWN §7 DEVIATION (as in runFlaggedReview): the read-only harness runs with `cwd`
    // on the live checkout rather than an immutable materialisation (that layer is not
    // built yet). Named so it is not read as satisfied.
    const decomposition = decompose(patchset);
    const manifest = buildOfferedManifest(decomposition);
    const offeredIds = new Set(
      manifest.occurrences.filter((occurrence) => occurrence.kind === "hunk").map((occ) => occ.id),
    );
    const hunks = decomposition.hunks
      .filter((hunk) => offeredIds.has(hunk.id))
      .map((hunk) => ({
        id: hunk.id,
        filePath: hunk.filePath,
        addedLines: hunk.addedLines,
        deletedLines: hunk.deletedLines,
      }));

    const runTurn = createCoverageTurn(adapter, { cwd: review.repositoryRoot });
    const result = await runCoverageMapping({
      patchsetId: patchset.id,
      requirements,
      hunks,
      // Guard the seat (issue #96): a thrown session construction degrades to a failed
      // turn (honest no-chips), never an uncaught crash of the coverage command.
      runTurn: guardSeatTurn(runTurn),
      budget: createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
    });
    return { status: result.status, edges: result.edges };
  }

  // The provenance seed for a live noise run (issue #34), mirroring the finding seed.
  // Provenance is stamped on the RSP document but not read by the Noise lens (groups
  // map straight to the lens), so a placeholder model is honest for placement; the
  // capability layers are set true because this path DOES constrain structured output
  // through the adapter. The `noise-job` chip's model label is threaded separately as
  // `noiseJobModel` (the harness we actually ran), not read from this seed.
  const NOISE_PROVENANCE_SEED = {
    harness: "claude-code",
    harnessVersion: "unknown",
    adapterVersion: "0.0.0",
    model: "unknown",
    modelReportedBy: "unknown" as const,
    capability: {
      structuredOutput: {
        implementedByAdapter: true,
        advertisedByHarness: true,
        availableInSession: true,
      },
      perCallModelSelection: {
        implementedByAdapter: true,
        advertisedByHarness: true,
        availableInSession: true,
      },
    },
  };

  /**
   * The live Noise lens runner (issue #34), replacing `noiseReviewFixture`. Decomposes
   * the review's active patchset into the offered hunk manifest and runs the noise
   * angle on the user's `claude` (subscription OAuth), budget-gated. The emitted
   * `noise` document's grounded groups become the lens's `NoiseReview` behind the SAME
   * `noiseReview` boundary — the UI is unchanged. With no discoverable harness, or on a
   * runner failure/budget refusal, the lens gets the LOUD `failed` state — "ran clean"
   * is never faked from "did not run" (the empty-vs-failed distinction the lens draws).
   *
   * MVP scope (see the PR): a single Claude turn classifies the churn and TAGS each
   * group `rule` (obvious mechanical churn, naming the rule) or `noise-job` (its own
   * judgement over ambiguous churn). The full deterministic mechanical-rules engine —
   * a separate admission authority that would settle the `rule` groups without a model
   * turn — is DEFERRED; today both chip types render, and the `rule` tag is the model's
   * "a mechanical certainty settles this" claim rather than a deterministic checker's.
   */
  async function runNoiseReviewWithContextFeed(
    review: Review,
    contextFeed: ReviewContextFeed,
  ): Promise<NoiseReview> {
    const patchset = activePatchset(review);
    const { locus, distroCwd } = locusContextForRepo(review.repositoryRoot);
    const { adapter } = await getClaudeHarness(locus, distroCwd);
    if (!adapter) {
      return { status: "failed", reason: "no model harness is available to classify noise" };
    }
    const decomposition = decompose(patchset);
    const manifest = buildOfferedManifest(decomposition);
    // KNOWN §7 DEVIATION (as in runFlaggedReview): the read-only harness runs with
    // `cwd` on the live mutable checkout rather than an immutable materialisation,
    // because that layer is not built yet. Follow-up: materialise the active patchset
    // to an app-owned cache and point `cwd` there. Do NOT read this as satisfied.
    const runNoiseTurn = createHarnessRunTurn(adapter, {
      docType: "noise",
      cwd: review.repositoryRoot,
    });
    // A noise run is its own live-budget-gated user action, distinct from
    // review.canvases; the ceiling stops spend, never the review (R10, fail-closed).
    const budget = createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS);
    // The per-project convention checklist (#180). Absent (no catalogue file), the
    // runner classifies churn exactly as before.
    const conventions = loadReviewConventions(review);
    const result = await runNoiseAngle({
      patchsetId: patchset.id,
      manifest,
      ...(conventions ? { conventions } : {}),
      provenance: NOISE_PROVENANCE_SEED,
      // The runner OWNS the noise-job chip's model label; we ran the Claude harness.
      noiseJobModel: "Claude",
      // A thrown/rejected turn (a session/transport construction exception, #96)
      // degrades to a turn-failure rather than crashing the command.
      runTurn: recordedDesktopSeatTurn(runNoiseTurn, "noise", contextFeed),
      budget,
      ...(contextFeed.assembledContext === undefined
        ? {}
        : { assembledContext: contextFeed.assembledContext }),
    });
    if (result.status === "ok") {
      return { status: "ok", groups: result.groups };
    }
    return {
      status: "failed",
      reason: result.failureReason ?? "the noise runner did not complete",
    };
  }

  async function runNoiseReview(review: Review): Promise<NoiseReview> {
    const contextFeed = await createDesktopReviewContextFeed(review, {
      onError: reportContextFeedError,
    });
    const completed = await runWithReviewContextFeed(contextFeed, () =>
      runNoiseReviewWithContextFeed(review, contextFeed),
    );
    return completed.result;
  }
  const store = new SqliteReviewStore(join(dataDir, "rennet.sqlite"));
  const projectStore = new FileProjectStore(join(dataDir, "projects.json"));
  const service = new ReviewService(capture, store);
  // The ProjectSnapshot generator over the app-owned LOCAL-FIRST store under
  // `~/.rennet/projects/` (issue #188 default base dir). Drives the initial context
  // dump: `project.process` builds each included repo's snapshot through this, and
  // its real stages become the processing screen's live narration. The store is
  // SHARED with the settings surface (below) so the per-project `config.json`
  // (visibility/promotion) they read and write is the same one the generator keys.
  const snapshotStore = liveSnapshotStore;
  const snapshotGenerator = new ProjectSnapshotGenerator({ store: snapshotStore, gitForRepo });
  // Proactive rehydration (#143/#243): keep each already-built project's structural
  // snapshot and knowledge warm as its reference branch advances. The background pass
  // narrates on the SAME progress push the processing screen uses (now WS `progressEvent`
  // frames fanned to every client, #378), under a stable command id, so the mechanism is
  // visible-capable with no new protocol surface. It only warms repos that already have a
  // snapshot — it never cold-builds in the background.
  // The knowledge-swarm scheduler (#460, B06): server/runtime/ is the wiring
  // point (reconciliation 3). It shares the rehydration progress push, so the
  // swarm's `knowledge`-stage lines land on the same screen as the build stages.
  // Fan ONE project's background narration to every connected client, on that
  // project's own channel. The optional caller hook stays for non-WS embedders;
  // the WS listener reaches the sockets that replaced the per-window
  // `webContents.send` broadcast (#378). The id is per-project because the
  // channel used to be process-global: every project's background pass landed
  // on every project's build timeline.
  const narrateBackground = (projectId: string, event: ProjectProcessEvent): void => {
    const commandId = proactiveRehydrationCommandId(projectId);
    options.broadcastProgress?.(commandId, event);
    wsListener?.broadcastProgress(commandId, event);
  };
  const knowledgeSwarmRuntime = createKnowledgeSwarmRuntime({
    store: snapshotStore,
    resolveClaudePort: claudeAdapterForRepo,
    resolveCodexExecutor: codexExecutorForRepo,
    narrate: narrateBackground,
  });
  // The project-scout scheduler (#461 §4, B7 cluster 4): shares the processing
  // progress push; the deterministic pass runs even with no harness installed.
  const projectScoutRuntime = createProjectScoutRuntime({
    store: snapshotStore,
    gitForRepo,
    resolveClaudePort: claudeAdapterForRepo,
    resolveCodexExecutor: codexExecutorForRepo,
    narrate: narrateBackground,
  });
  rehydration = createProactiveRehydration({
    store: snapshotStore,
    generator: snapshotGenerator,
    narrate: narrateBackground,
    // A background pass that throws is otherwise swallowed whole: with no
    // `onError` the rehydration registry, the watcher start and the knowledge
    // loop all had nowhere to put a failure.
    onError: (error) => console.error("Proactive rehydration failed", error),
    runNoveltyPass: (repoKey) => liveNoveltyLifecycle.advanceRepo(repoKey),
    // The knowledge pass is the council-routed partition swarm (#460, B06): the
    // swarm picks skip vs incremental vs full itself from the stored prior set's
    // identity, and its per-partition + verify lines ride the SAME rehydration
    // progress push as the narrate above. The typed outcome reaches the caller
    // INTACT — collapsing it to a boolean dropped every failure reason.
    runKnowledgePass: async ({ projectId, repoKey, repoRoot, toOid }) =>
      knowledgeSwarmRuntime.runForRepo({ projectId, repoKey, repoRoot, toOid }),
  });
  // At launch, resume warming every project whose Repo Map already exists.
  for (const project of projectStore.list()) void rehydration.ensureForProject(project);
  // The initial context dump's core, wrapped below so a successful process also starts
  // keeping that project's freshly-built Repo Map warm.
  const processProjectCore = createProcessProject({
    generate: (repoRoot, options) => snapshotGenerator.generate(repoRoot, options),
    listProjects: () => projectStore.list(),
  });
  // The app-side settings stores (B10 #476): viewer preferences (appearance,
  // keybindings) in `client-settings.json`, the host's global ladder rung (the
  // listener bind) in `daemon-settings.json`. A legacy `config.json` v1 blob is
  // migrated mechanically into the two on first construction — one-way, idempotent,
  // lossless. Both are sibling to the project snapshot store; neither is a repo fact.
  const clientSettingsPath = join(dataDir, "client-settings.json");
  const daemonSettingsPath = join(dataDir, "daemon-settings.json");
  migrateLegacyGlobalConfig({
    legacyPath: defaultGlobalConfigPath(),
    clientPath: clientSettingsPath,
    daemonPath: daemonSettingsPath,
  });
  const clientSettingsStore = createClientSettingsStore(clientSettingsPath);
  const daemonSettingsStore = createDaemonSettingsStore(daemonSettingsPath);
  // The device pairing store (issue #380): server-side secret store for remote
  // device tokens (hashed at rest in `~/.rennet/devices.json`). Shared between the
  // `pairing.*` commands (below) and the WS listener's handshake token check.
  const pairingStore = new PairingStore(join(dataDir, "devices.json"));
  // The push-token store (issue #383 M1): one row per paired device, keyed by device id,
  // in `~/.rennet/push-tokens.sqlite`. Shared between `device.registerPush` (set/delete),
  // the attention planner (list + dead-token cleanup), and revoke (delete stops pushes).
  const pushTokenStore = new PushTokenStore(join(dataDir, "push-tokens.sqlite"));
  // Which reviews have a model turn in flight (#383 batch) — the real source of projected
  // `attention.running`, marked by dispatch and read by the projection context below.
  const inFlightReviews = new InFlightReviews();
  // The publish egress port + its consent authority (issue #21). The port constructs
  // requests purely (dry-run) and posts only via the gated `publish.review` command.
  const publishPort = new GitHubPublishAdapter({ resolveOctokit: resolveGitHubOctokit });
  // The own-branch PR submission (issue #257 / #107): push the review's own branch,
  // then open a real PR. Pushing your own branch is not publishing (AGENTS.md) — the
  // agent loop pushes freely — so this is a plain git push + a REST create, with the
  // repo's GitHub identity resolved from its own remotes (never a path-name guess).
  const prSubmissionAdapter = new GitHubPrSubmissionAdapter({
    resolveOctokit: resolveGitHubOctokit,
  });
  const submitPullRequest = async (input: {
    repoRoot: string;
    headRef: string;
    submission: ForgePrSubmission;
  }): Promise<ForgePrSubmissionOutcome> => {
    // Git runs inside the project's locus (add-windows-support): a WSL-locus repo's
    // remote lookup and push execute in the distro, against the distro-native repo.
    const gitInLocus = execaGitFor(locusForRepo(input.repoRoot));
    // Resolve ONE GitHub remote — the single source for BOTH the push destination and
    // the PR repo, so they can never disagree (prefer `origin`, the North Star of your
    // own repo). A repo with no GitHub remote has nowhere to open a PR — say so.
    const remote = await resolveForgeRemote(gitInLocus, input.repoRoot);
    if (!remote) {
      throw new Error(
        "No GitHub remote is configured for this repository, so there is nowhere to open a pull request.",
      );
    }
    // Push the NAMED reviewed branch, not the current HEAD: the PR must open from the
    // branch the review is about, even if HEAD has since moved to another branch.
    await gitInLocus(input.repoRoot, [
      "push",
      remote.name,
      `refs/heads/${input.headRef}:refs/heads/${input.headRef}`,
    ]);
    return prSubmissionAdapter.submitPullRequest({
      target: {
        repo: { forge: "github", owner: remote.identity.owner, name: remote.identity.name },
      },
      submission: input.submission,
    });
  };
  // #251: the durable conversation store (~/.rennet/threads). Backs both re-attach
  // (reload persisted threads, crash-recovered) and persistence (write a streaming
  // placeholder that recovers as interrupted if this process dies mid-answer).
  const threadStore = new FileThreadStore(join(dataDir, "threads"));
  // B11: the durable ask-log store (~/.rennet/asks), sibling to the thread store.
  // Backs the `ask.*` write path (the sole writers) and the reload-survival read
  // a reconnecting client rehydrates from (`ask.read`).
  const askLogStore = new AskLogStore(join(dataDir, "asks"));
  // The durable session store (B09) — the cursor the turn loop resumes from and the rows
  // the sidebar lists both live here.
  const sessionStore = new SessionStore(join(dataDir, "sessions"));
  // The display-transcript store (issue-set B): the durable read-model behind
  // `session.transcript`. The turn loop's `recordTranscript` sink (below) is its only writer.
  const transcriptStore = new TranscriptStore(join(dataDir, "transcripts"));
  // ── The session turn loop, instantiated (B09 cluster 2's loop, wired here) ───────────────
  //
  // Every coding turn a round dispatches now runs THROUGH the loop. TWO of the loop's
  // behaviours become real by that wiring — and only two:
  //
  //   • RESUME. Options are re-passed fresh each turn (a fresh process is never sticky) and
  //     the advanced `HarnessCursor` persists, so the next round RESUMES the same conversation
  //     instead of starting cold — and a resume the CLI no longer has rebuilds context
  //     honestly rather than silently.
  //   • CAPTURE. The `recordTranscript` sink is the WRITE side of `session.transcript` (C07):
  //     the harness events the loop already sees, projected to display rows and appended
  //     VERBATIM to the durable store the read serves (R19 is applied at the wire, for a
  //     projected connection only — see `projectCommandOutput`). Nothing is
  //     fabricated — a session whose turns have not run reads back empty because it genuinely
  //     has no rows. The `emit` sink carries the loop's SYNTHESIZED `context_rebuilt` marker,
  //     which is not a harness event and so cannot come from the projector.
  //
  // Serialization is NOT one of them: `createRoundsRuntime` already enqueues the whole dispatch
  // per session id, INCLUDING the checkpoint bracket, and it is the only caller passing a
  // sessionId. The loop's own serializer is a redundant second lock here — and the weaker one,
  // since loop-only would leave the brackets unserialized and round 2's `turnDiff` would then
  // include round 1's changes.
  //
  // ONE loop per repo root, and the repo root is the SINGLE source of the turn's cwd: the loop
  // key IS what `buildSpec` returns, so there is no second copy of that fact to drift. The port
  // is that repo's own resolved `claude` adapter (host or distro), so a WSL project's turns run
  // its claude.
  const sessionTurnLoops = new Map<string, SessionTurnLoop>();
  function turnLoopForRepo(repoRoot: string, port: HarnessPort): SessionTurnLoop {
    const existing = sessionTurnLoops.get(repoRoot);
    if (existing) return existing;
    const loop = new SessionTurnLoop({
      port,
      store: sessionStore,
      // Rebuilt fresh every turn, from the loop's own key. The loop merges the resume pointer
      // itself from the just-loaded cursor.
      buildSpec: () => ({ cwd: repoRoot }),
      // The WRITE side of `session.transcript`: project → append, raw (failure-isolated;
      // a display read-model never fails the coding turn that produced it).
      recordTranscript: createTranscriptCapture(transcriptStore, (error) =>
        console.error("Session transcript capture failed", error),
      ),
      // The resume-vanished marker. Without it the transcript reads CONTINUOUS across a context
      // loss — a surface claiming something it cannot know.
      emit: createContextRebuiltEmit(transcriptStore, (error) =>
        console.error("Session transcript capture failed", error),
      ),
    });
    sessionTurnLoops.set(repoRoot, loop);
    return loop;
  }
  // The write-enabled coding-agent turn (issue #18): brackets a live `claude` write turn
  // with git checkpoints and returns the turn diff. Extracted to a local so BOTH the
  // `review.handoff.run` command and the B11 round dispatch (below) run the same turn.
  const runHandoffTurnDefault = async ({
    repoRoot,
    prompt,
    sessionId,
    execution: requestedExecution,
  }: HandoffTurnInput): Promise<HandoffTurnOutcome> => {
    const execution = requestedExecution ?? handoffTurnExecution(locusForRepo(repoRoot), repoRoot);
    const locus: Locus =
      execution.kind === "host" ? HOST_LOCUS : { kind: "wsl", distro: execution.distro };
    // The SDK prepends this distro cwd to its direct wsl.exe spawn.
    const distroCwd = execution.kind === "wsl" ? execution.cwd : undefined;
    if (await repoHasSubmodules(repoRoot, locus)) {
      return {
        status: "failed",
        reason:
          "Handoff does not support repositories with submodules yet: a coding agent's edits inside a submodule leave the gitlink unchanged, so the review would not see them. Refusing rather than losing them.",
        turnDiff: "",
        filesTouched: [],
      };
    }
    const { adapter } = await getClaudeHarness(locus, distroCwd);
    if (!adapter) {
      return {
        status: "failed",
        reason: "no coding harness (claude) is installed to run the handoff",
        turnDiff: "",
        filesTouched: [],
      };
    }
    // Only a session that is ACTUALLY persisted rides the loop — the loop resumes from and
    // writes back a stored record, so an unpersisted id would throw rather than run.
    const loopSession =
      sessionId !== undefined && sessionStore.load(sessionId) !== undefined ? sessionId : undefined;
    return runHandoffTurnCore({
      repoRoot,
      prompt,
      runPort:
        loopSession === undefined
          ? claudeHandoffRunPort(adapter)
          : turnLoopRunPort(turnLoopForRepo(repoRoot, adapter), loopSession),
      checkpoint: new GitCheckpointStore(repoRoot, locus),
    });
  };
  const runHandoffTurn = options.runHandoffTurn ?? runHandoffTurnDefault;
  // B4 broadcast wiring (reconciliation 7, recorded): board events ride the EXISTING
  // WS push path — the runtime's store-append hook feeds `wsListener.broadcastBoardEvent`
  // (late-bound: `wsListener` is assigned below, read only when a board event fires), which
  // fans raw frames to loopback sockets and `projectBoardEvent`-wrapped ones to projected
  // sockets. One runtime per project root, created on demand.
  const boardsRuntimes = new Map<string, BoardsRuntime>();
  const boardsRuntimeFor = (projectRoot: string): BoardsRuntime => {
    let runtime = boardsRuntimes.get(projectRoot);
    if (!runtime) {
      runtime = createBoardsRuntime(projectRoot, (boardId, events) =>
        wsListener?.broadcastBoardEvent(boardId, events),
      );
      boardsRuntimes.set(projectRoot, runtime);
    }
    return runtime;
  };
  // The rounds runtime + session entry (B11 cluster 4 — closes B09 tasks 5.1/6.2's ledgered
  // deferral: the mechanism was built and E2E-composed, the create-server trigger is here).
  // The 6.2 seams, resolved from the composition root following the swarm/scout precedent:
  // harness ports probe live; `boardsRuntimeFor` mints + broadcasts boards; the durable
  // `BoardMetaStore` is the crash-boundary idempotency the `runRound` regeneration consults
  // (persist before arrival, load on restart); prompts read from the on-disk `@rennet/prompts`
  // src. `composeTurn` is omitted (optional — the lens boards are the surface until the
  // authoring turn is wired). The lens-pipeline collation context IS bridged now (C15
  // cluster 1, `runtime/round-collation.ts`): the dispatch runs the coding turn behind the
  // per-session serializer and then hands what the worker produced to `runRound` for the
  // full board regeneration, so the dispatch still never runs an empty pipeline.
  const boardMetaStore = new BoardMetaStore(join(dataDir, "board-meta"));
  // Durable generation ledger (C15 2.1): the frozen prior + live successor a round mints,
  // so gen-1 survives a restart as a drill-down the rounds switcher opens by id.
  const generationStore = new GenerationStore(join(dataDir, "generations"));
  // Durable rounds ledger (C15 2.2): one record per round, reconciled — the regeneration
  // round's real generation + frozen-predecessor id supersedes the dispatch placeholder.
  const roundRecordStore = new RoundRecordStore(join(dataDir, "rounds"));
  const sidebarSessionFor = (session: SessionModel) =>
    sidebarSessionOf(session, roundRecordStore.read(session.id));
  // The live round-progress channel (C15 3.1): an append-only `RoundEvent` log per review,
  // pushed to live sockets as it grows and read back by a client that joins mid-round. The
  // WS listener is late-bound (assigned below), exactly as the board/ask fan-outs are.
  const roundProgress = new RoundProgressHub((reviewId, event) =>
    wsListener?.broadcastRoundProgress(reviewId, event),
  );
  const promptsSrcDir = (() => {
    try {
      // Dev/test/source: `@rennet/prompts` exports `./src/index.ts`; its dir is the
      // prompt-file root the reader joins `prompts/<lens>.md` against.
      return dirname(createRequire(import.meta.url).resolve("@rennet/prompts"));
    } catch {
      // Bundled daemon: `@rennet/prompts` is INLINED into the bundle, so it cannot be
      // require.resolve'd at runtime. Each bundler copies the prompt files to
      // `<bundle-dir>/prompts/` (the desktop server bundle via `vite.server.config.ts`, the
      // CLI bundle via `build-server-cli.mjs`), so the root the reader joins `prompts/<file>`
      // against is the bundle's OWN directory. The old fallback (`~/.rennet/prompts`) was
      // wrong twice over: nothing ships prompts there, and joining `prompts/<file>` doubled
      // the segment (`~/.rennet/prompts/prompts/post-process.md`) — every drafter hit ENOENT
      // and no board was ever drafted in the packaged app.
      //
      // `__dirname` is the load-bearing source here: it is the real Node global in EVERY CJS
      // bundle, whereas `import.meta.url` is only defined in the desktop bundle (which injects
      // it via vite `define`) — in the CLI bundle it is `undefined`, so `fileURLToPath` of it
      // threw at startup and the daemon never published its claim. `typeof` guards the ESM
      // dev/test path (no `__dirname`), which never reaches this catch anyway because the
      // require.resolve above succeeds there.
      return typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
    }
  })();
  const sessionEntry = new SessionEntry(sessionStore);
  // The ONE key both session mints converge on (#580): the `Project.id` the sidebar groups by,
  // resolved from a review's repo root through the stored projects. `projectStore.list()` is read
  // per call, not captured, so a project added after boot is covered at once.
  const projectIdOf = (repoRoot: string): string =>
    projectIdForRepoRoot(repoRoot, projectStore.list());
  // The read side of that convergence, in ONE place so the four session-keyed durable reads
  // (rounds ledger, transcript, board idempotency, and the per-session round lock the dispatch
  // takes) cannot drift apart. Get this out of step with the mint below and `session.rounds`,
  // `session.transcript` and `board.read` all go honest-empty at once.
  const sessionIdForReview = (review: Review): string =>
    resolveRoundSessionId(review, sessionStore.list(), projectIdOf(review.repositoryRoot));
  const roundsRuntime = createRoundsRuntime({
    resolveClaudePort: claudeAdapterForRepo,
    resolveCodexExecutor: codexExecutorForRepo,
    boardsRuntimeFor,
    readPrompt: createNodePromptReader(promptsSrcDir),
    persistBoardMeta: (_repoRoot: string, meta: PersistedBoardMeta) => boardMetaStore.save(meta),
    loadDraftedBoards: (_repoRoot: string, sessionId: string, generation: string) =>
      boardMetaStore.listForGeneration(sessionId, generation),
    persistGeneration: (gen) => generationStore.save(gen),
    recordRound: (sessionId, record) => roundRecordStore.record(sessionId, record),
    readRounds: (sessionId) => roundRecordStore.read(sessionId),
    loadGeneration: (id) => generationStore.load(id),
  });

  /**
   * The deps a generation's boards are drafted through, for ONE review's session.
   *
   * Shared by the two callers, because they differ in exactly ONE thing — whether a coding
   * turn ran first. The knowledge set the drafters read, the whole-tree citation inventory
   * lint resolves against, the prior generation carry is decided by, and the rounds runtime
   * itself are identical either way, and were identical when they were written twice.
   */
  const boardDraftingDeps = (
    review: Review,
    session: SessionModel,
    recapture: () => Promise<void>,
    emit: (event: RoundEvent) => void,
  ): BoardRegenerationDeps => ({
    recapture,
    reviewNow: () => service.reviewById(review.id) ?? review,
    // The drafters' knowledge is SELECTED, not dumped (context-map rebuild, W5b):
    // this seam hands over the stored set plus the snapshot gated fresh at the
    // patchset's own base OID, and `assembleRoundCollation` projects (invalidated
    // disclosed, rejected dropped), scopes to the change's 1-hop import
    // neighbourhood, and caps — disclosing all three in the packet. A gate refusal
    // is a null snapshot, which degrades to the unprojected set and SAYS so; it is
    // never a silently narrower one.
    //
    // The reader is the OVERLAY-MERGED one, the same shape the review's own
    // `context.file`/`context.map` tools are built with: a review on a
    // non-default base resolves through a warmed overlay, and a bare reader
    // would refuse it as stale. Without this the packet could degrade to
    // `unprojected` on a review whose context tools were answering fine —
    // two readers disagreeing about the same review's snapshot.
    knowledgeFor: (patchset: Patchset) => {
      const repoKey = repoKeyForRoot(review.repositoryRoot);
      const overlayReader = new SnapshotOverlayReader({
        store: liveSnapshotStore,
        overlayStore: new SnapshotOverlayStore(liveSnapshotStore),
      });
      const gated = new ProjectContextReader(liveSnapshotStore, overlayReader).loadFresh(
        repoKey,
        patchset.repository.baseOid,
      );
      return {
        set: new KnowledgeStore(liveSnapshotStore).loadLocal(repoKey) ?? null,
        snapshot: gated.ok ? gated.snapshot : null,
      };
    },
    // W5 — the WHOLE-TREE citation grounding. Drafters read past the diff, so
    // lint resolves citations against every text file at the reviewed head and
    // base, not only the changed ones. Two `git grep -c` passes over the repo's
    // own git (locus-aware), ~80 ms on a 2.4k-file tree; a side git could not
    // read comes back empty and degrades to the diff on that side alone.
    fileInventory: (patchset: Patchset) =>
      readTreeLineCounts(
        patchset.repository.root,
        patchset.repository.reviewedTreeOid ?? patchset.repository.headOid,
        patchset.repository.baseOid,
        gitForRepo(patchset.repository.root),
      ),
    designArtifactsFor: (patchset: Patchset) =>
      discoverDesignArtifacts({
        patchset,
        git: gitForRepo(patchset.repository.root),
      }),
    readFindingDispositions: () => ({
      ...askLogStore.readProjection(review.id).findingDispositions,
    }),
    persistFindingResolutions: (
      successorGeneration,
      successorBoardId,
      resolutions,
      findingDispositions,
    ) => {
      const events = findingDispositionMigrationEvents({
        findingDispositions,
        successorGeneration,
        successorBoardId,
        resolutions,
      });
      askLogStore.appendMany(review.id, events);
      if (events.length > 0) {
        wsListener?.broadcastAskProjection(review.id, askLogStore.readProjection(review.id));
      }
    },
    // The REAL prior generation, rebuilt from its two durable halves (the generation
    // record + the board-meta rows' projected boards). Absent ⇒ this session has
    // never drafted over that patchset, so this is honestly a first generation.
    priorGeneration: (generationId: string) =>
      readPriorGeneration(
        {
          loadGeneration: (id) => generationStore.load(id),
          listBoardMeta: (sessionId, generation) =>
            boardMetaStore.listForGeneration(sessionId, generation),
          boardElements: async (boardId) => [
            ...(await boardsRuntimeFor(review.repositoryRoot).service.getState(boardId)).values(),
          ],
        },
        session.id,
        generationId,
      ),
    runRound: (input: Parameters<typeof roundsRuntime.runRound>[0]) =>
      roundsRuntime.runRound(input),
    emit,
  });

  const roundOperationStore = new RoundOperationStore(join(dataDir, "round-operations"));
  const roundWorktreeRoot = join(dataDir, "round-worktrees");
  mkdirSync(roundWorktreeRoot, { recursive: true });
  const composeRoundBundle = createLiveComposeBundle({
    claudePort: claudeAdapterForRepo,
    codexExecutor: codexExecutorForRepo,
  });

  // Bound after the round coordinator because its ports dispatch report regeneration.
  // eslint-disable-next-line prefer-const
  let dispatch: ReturnType<typeof createDispatch>;

  const activePatchsetFor = (review: Review): Patchset => {
    const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
    if (patchset === undefined) {
      throw new Error(`Review ${review.id} has no active patchset.`);
    }
    return patchset;
  };

  const sourcePatchsetFor = (operation: RoundOperation): Patchset => {
    const review = service.reviewById(operation.reviewId);
    const patchset = review?.patchsets.find(
      (candidate) => candidate.id === operation.sourcePatchsetId,
    );
    if (patchset === undefined) {
      throw new Error(`Round ${operation.operationId} lost its source patchset.`);
    }
    return patchset;
  };

  const sessionForOperation = (operation: RoundOperation): SessionModel => {
    const session = sessionStore.load(operation.sessionId);
    if (session === undefined) {
      throw new Error(`Round ${operation.operationId} lost its session.`);
    }
    return session;
  };

  const exactWorkOrderFor = (operation: RoundOperation) => {
    const patchset = sourcePatchsetFor(operation);
    const projection = projectionForAskOccurrences(
      askLogStore.read(operation.reviewId),
      operation.askOccurrences,
    );
    return mechanicalComposition(
      buildHandoffBundle({
        reviewId: operation.reviewId,
        patchset,
        dispositions: handoffDispositionsFromProjection(projection, patchset),
      }),
    );
  };

  const createRoundOperation = (input: {
    readonly session: SessionModel;
    readonly review: Review;
    readonly workOrder: { readonly prompt: string };
    readonly dispatchId: string;
    readonly sourcePatchsetId: string;
    readonly askOccurrences: readonly RoundOperation["askOccurrences"][number][];
  }): RoundOperation => {
    const patchset = input.review.patchsets.find(
      (candidate) => candidate.id === input.sourcePatchsetId,
    );
    if (patchset === undefined) {
      throw new Error(
        `Review ${input.review.id} lost dispatch patchset ${input.sourcePatchsetId}.`,
      );
    }
    const gateCommand = scoutSettingsOffers(
      snapshotStore,
      repoKeyForRoot(input.review.repositoryRoot),
    ).gateCommand?.trim();
    const createdAt = Date.now();
    return {
      operationId: randomUUID(),
      sessionId: input.session.id,
      reviewId: input.review.id,
      dispatchId: input.dispatchId,
      sourcePatchsetId: input.sourcePatchsetId,
      askOccurrences: [...input.askOccurrences],
      roundNumber: roundRecordStore.read(input.session.id).length + 1,
      sourceTarget:
        patchset.repository.headRef === undefined
          ? { kind: "detached", head: patchset.repository.headOid }
          : { kind: "branch", branch: patchset.repository.headRef },
      repoRoot: input.review.repositoryRoot,
      workOrderPrompt: input.workOrder.prompt,
      workOrderDigest: sha256Hex(input.workOrder.prompt),
      gatePlan:
        gateCommand === undefined || gateCommand.length === 0
          ? { kind: "absent" }
          : { kind: "configured", command: gateCommand },
      revision: 0,
      rerunRequested: false,
      createdAt,
      updatedAt: createdAt,
      state: { phase: "claimed" },
    };
  };

  const publishRoundOperation = (operation: RoundOperation): void => {
    roundProgress.emit(operation.reviewId, {
      type: "operation",
      snapshot: roundOperationProgressSnapshot(operation),
    });
  };

  const planRoundWorkspace = createRoundWorkspacePlanner({
    dataDir,
    sourceRepositoryFor: (operation) => sourcePatchsetFor(operation).repository,
  });
  const runRoundWorker = createRoundWorkerPort({ runHandoffTurn });

  const coordinator = createRoundExecutionCoordinator({
    store: roundOperationStore,
    ports: {
      planWorkspace: planRoundWorkspace,
      prepareWorkspace: ({ operation, attempt }) =>
        prepareRoundWorkspace({
          git: gitForRepo(operation.repoRoot),
          locus: locusForRepo(operation.repoRoot),
          repoRoot: operation.repoRoot,
          operationId: operation.operationId,
          attempt,
        }),
      planWorker: () => ({ executionId: randomUUID(), startedAt: Date.now() }),
      runWorker: runRoundWorker,
      planGate: () => ({ executionId: randomUUID(), startedAt: Date.now() }),
      runGate: async ({ operation, attempt }) => {
        if (operation.state.phase !== "gate-running" || operation.gatePlan.kind !== "configured") {
          throw new Error("Configured round gate started without a durable gate plan.");
        }
        const result = await runConfiguredRoundGate({
          locus: locusForRepo(operation.repoRoot),
          cwd: operation.state.workspace.worktreePath,
          command: operation.gatePlan.command,
          executionId: attempt.executionId,
          startedAt: attempt.startedAt,
        });
        const common = {
          executionId: result.executionId,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
          ...(result.projectCount === undefined ? {} : { projectCount: result.projectCount }),
        };
        return result.outcome === "passed"
          ? { ...common, outcome: "passed" as const, exitCode: 0 as const }
          : { ...common, outcome: "failed" as const, termination: result.termination };
      },
      planCommit: (operation) => {
        if (operation.state.phase !== "gate-settled") {
          throw new Error("Round commit planned before its gate settled.");
        }
        return {
          executionId: randomUUID(),
          baseHead: operation.state.workspace.sourceHead,
          startedAt: Date.now(),
        };
      },
      settleCommits: async ({ operation, attempt }) => {
        if (operation.state.phase !== "committing") {
          throw new Error("Round commit effect started outside its durable commit phase.");
        }
        return settleRoundCommits({
          git: gitForRepo(operation.repoRoot),
          worktreePath: operation.state.workspace.worktreePath,
          executionId: attempt.executionId,
          baseHead: attempt.baseHead,
          startedAt: attempt.startedAt,
        });
      },
      planSourceLanding: (operation) => {
        if (operation.state.phase !== "commits-settled") {
          throw new Error("Round source landing planned before commits settled.");
        }
        return {
          effect: "source-landing",
          executionId: randomUUID(),
          baselineCommit: operation.state.commits.from,
          workerHead: operation.state.commits.to,
          startedAt: Date.now(),
        };
      },
      landSourceChanges: async ({ operation, attempt }) => {
        if (operation.state.phase !== "source-landing") {
          throw new Error("Round source landing started outside its durable landing phase.");
        }
        const result = await landRoundChanges({
          git: gitForRepo(operation.repoRoot),
          locus: locusForRepo(operation.repoRoot),
          sourceRoot: operation.repoRoot,
          worktreePath: operation.state.workspace.worktreePath,
          baselineCommit: attempt.baselineCommit,
          workerHead: attempt.workerHead,
        });
        if (
          result.baselineCommit !== attempt.baselineCommit ||
          result.workerHead !== attempt.workerHead
        ) {
          throw new Error("Round source landing returned a different commit range.");
        }
        return { ...attempt, outcome: result.outcome, landedAt: Date.now() };
      },
      planRoundRecording: (operation) => {
        if (operation.state.phase !== "source-landed") {
          throw new Error("Round recording planned before source landing settled.");
        }
        return {
          effect: "round-recording",
          executionId: randomUUID(),
          startedAt: Date.now(),
        };
      },
      recordRound: async ({ operation, attempt }) => {
        if (operation.state.phase !== "round-recording") {
          throw new Error("Round recording started outside its durable recording phase.");
        }
        const workOrder = exactWorkOrderFor(operation);
        const worker = operation.state.worker;
        const commits = operation.state.commits;
        const gate: RoundRunReceipt["gate"] =
          operation.state.gate.outcome === "skipped"
            ? { outcome: "skipped", reason: "not-configured" }
            : operation.gatePlan.kind === "configured"
              ? {
                  outcome: "passed",
                  command: operation.gatePlan.command,
                  durationMs: Math.max(
                    0,
                    operation.state.gate.completedAt - operation.state.gate.startedAt,
                  ),
                  ...(operation.state.gate.projectCount === undefined
                    ? {}
                    : { projectCount: operation.state.gate.projectCount }),
                }
              : (() => {
                  throw new Error("A passed round gate has no configured command.");
                })();
        await roundsRuntime.dispatchRound({
          session: sessionForOperation(operation),
          workOrder,
          dispatchId: operation.dispatchId,
          sourcePatchsetId: operation.sourcePatchsetId,
          askOccurrences: operation.askOccurrences,
          run: {
            startedAt: operation.createdAt,
            sourceTarget: operation.sourceTarget,
            gate,
          },
          runWorkers: async (): Promise<DispatchRoundResult> => ({
            outcome: "completed",
            diff: worker.diff,
            changedPaths: [...worker.changedPaths],
            workerCommitRange: {
              from: commits.from,
              to: commits.to,
            },
          }),
        });
        await options.onRoundPlaceholderCommitted?.({
          sessionId: operation.sessionId,
          dispatchId: operation.dispatchId,
        });
        return { ...attempt, recordedAt: Date.now() };
      },
      prepareReport: (operation) => {
        const idFor = (target: string): string =>
          `round-${sha256Hex(`${operation.operationId}:${target}`).slice(0, 32)}`;
        const boardIds = {
          design: idFor("design"),
          sequence: idFor("sequence"),
          decisions: idFor("decisions"),
          flagged: idFor("flagged"),
          noise: idFor("noise"),
          report: idFor("report"),
        };
        return {
          executionId: randomUUID(),
          reportBoardId: boardIds.report,
          generation: idFor("generation"),
          boardIds,
          startedAt: Date.now(),
        };
      },
      draftReport: async ({ operation, attempt }) => {
        if (operation.state.phase !== "report-drafting") {
          throw new Error("Round report started outside its durable drafting phase.");
        }
        await dispatch("review.regenerate", {
          commandId: randomUUID(),
          reviewId: operation.reviewId,
          repoPath: operation.repoRoot,
        });
        const review = service.reviewById(operation.reviewId);
        if (review === null) throw new Error("Round recapture did not return its review.");
        const session = sessionForOperation(operation);
        const workOrder = exactWorkOrderFor(operation);
        const previousGeneration = currentGenerationId(
          roundRecordStore.read(session.id),
          operation.sourcePatchsetId,
        );
        const regenerated = await runBoardRegeneration(
          boardDraftingDeps(
            review,
            session,
            async () => undefined,
            () => undefined,
          ),
          {
            session,
            repoRoot: operation.repoRoot,
            priorPatchsetId: operation.sourcePatchsetId,
            asksDispatched: operation.askOccurrences.map((occurrence) => occurrence.id),
            dispatchId: operation.dispatchId,
            sourcePatchsetId: operation.sourcePatchsetId,
            askOccurrences: operation.askOccurrences,
            round: {
              number: operation.roundNumber,
              previousGeneration,
              dispatchedAsks: workOrder.tasks.flatMap((task) => task.asks),
              findingDispositions: {},
            },
            worked: {
              commitRange: {
                from: operation.state.commits.from,
                to: operation.state.commits.to,
              },
              diff: operation.state.worker.diff,
              changedPaths: operation.state.worker.changedPaths,
            },
            draftPlan: { generation: attempt.generation, boardIds: attempt.boardIds },
            recaptured: true,
          },
        );
        const record = roundRecordStore
          .read(session.id)
          .findLast((candidate) => candidate.dispatchId === operation.dispatchId);
        if (
          !regenerated ||
          record?.boardGeneration !== attempt.generation ||
          record.reportBoard !== attempt.reportBoardId
        ) {
          throw new Error("Round regeneration did not persist its preplanned report.");
        }
        return { ...attempt, draftedAt: Date.now() };
      },
      planReportVerification: () => ({ executionId: randomUUID(), startedAt: Date.now() }),
      verifyReport: async ({ operation, report, attempt }) => {
        const elements = [
          ...(
            await boardsRuntimeFor(operation.repoRoot).service.getState(report.reportBoardId)
          ).values(),
        ];
        const reportedAskIds = new Set<string>();
        for (const element of elements) {
          if (element.kind !== "round_outcome") continue;
          const data = element.data as {
            readonly status?: unknown;
            readonly ask?: { readonly ref?: unknown };
          };
          if (data.status !== "beyond" && typeof data.ask?.ref === "string") {
            reportedAskIds.add(data.ask.ref);
          }
        }
        const missing = operation.askOccurrences
          .map((occurrence) => occurrence.id)
          .filter((id) => !reportedAskIds.has(id));
        if (missing.length > 0) {
          throw new Error(`Round report omitted dispatched asks: ${missing.join(", ")}`);
        }
        return {
          ...report,
          verificationExecutionId: attempt.executionId,
          verificationStartedAt: attempt.startedAt,
          verifiedAt: Date.now(),
        };
      },
      publish: publishRoundOperation,
      drainTerminal: async ({ operation }) => {
        if (operation.state.phase === "completed") {
          const session = sessionForOperation(operation);
          if (operation.state.result.kind === "unchanged") {
            await roundsRuntime.finalizeUnchanged({
              session,
              asksDispatched: operation.askOccurrences.map((occurrence) => occurrence.id),
              dispatchId: operation.dispatchId,
              sourcePatchsetId: operation.sourcePatchsetId,
              askOccurrences: operation.askOccurrences,
              workerCommitRange: {
                from: operation.state.commits.from,
                to: operation.state.commits.to,
              },
              onProgress: (event) => roundProgress.emit(operation.reviewId, event),
            });
          }
          consumeCurrentAskOccurrences(
            {
              askLog: askLogStore,
              broadcastAskProjection: (reviewId, projection) =>
                wsListener?.broadcastAskProjection(reviewId, projection),
            },
            operation.reviewId,
            operation.askOccurrences,
          );
          await removeRoundWorktree({
            git: gitForRepo(operation.repoRoot),
            locus: locusForRepo(operation.repoRoot),
            repoRoot: operation.repoRoot,
            worktreePath: operation.state.workspace.worktreePath,
            sourceHead: operation.state.workspace.sourceHead,
          });
          await releaseRoundSourceCommit({
            git: gitForRepo(operation.repoRoot),
            repoRoot: operation.repoRoot,
            operationId: operation.operationId,
            commit: operation.state.workspace.sourceHead,
          });
        }
        if (!operation.rerunRequested) return { kind: "retain" };
        const review = service.reviewById(operation.reviewId);
        if (review === null) throw new Error("Queued round lost its review.");
        const draft = activeRoundDraft(
          askLogStore.read(review.id),
          review.id,
          activePatchsetFor(review),
        );
        if (draft === undefined) return { kind: "clear-queued" };
        const workOrder = await composeRoundBundle({
          bundle: draft.bundle,
          repoRoot: review.repositoryRoot,
        });
        return {
          kind: "replace",
          operation: createRoundOperation({
            session: sessionForOperation(operation),
            review,
            workOrder,
            dispatchId: draft.dispatchId,
            sourcePatchsetId: draft.bundle.patchsetId,
            askOccurrences: draft.askOccurrences,
          }),
        };
      },
    },
  });

  /**
   * Draft the FIRST generation's boards over a review the reviewer just opened.
   *
   * `product-and-vision.md` draws it as `local --> boards` and `remote --> boards`: you
   * capture a change and you READ it as boards. Nothing in that sentence waits on a coding
   * round. But until this existed the drafting pipeline had exactly one caller — the round
   * regeneration tail below — and a round only runs on staged asks, which the reviewer can
   * only stage BY READING A BOARD. So a captured review never got a board, and could not
   * get one: the first thing a new reviewer saw was an empty board, permanently.
   *
   * Same machinery as that tail, with an empty checkpoint result, so nothing re-captures,
   * nothing "landed", and `runRound` mints the FIRST generation over the
   * patchset the drafters are reading. No successor account exists, so the round-report seat
   * does not run — this is a first read of a change, not a report on a round.
   *
   * Idempotent by construction, and that is what makes it safe to kick from every door: the
   * pipeline start guard dedups within the process and the durable BoardMeta for
   * `(session, generation)` dedups across a restart, so re-opening a review whose patchset
   * has not moved reconstructs the boards it already has instead of re-drafting twelve. A
   * capture that produced a NEW patchset is a new generation and does draft again — which is
   * exactly what a changed tree deserves.
   *
   * Failure-isolated. The review is captured and persisted either way; a drafting failure
   * must never take the capture down with it.
   */
  async function draftBoardsForReview(review: Review): Promise<void> {
    const patchset = review.patchsets.find((p) => p.id === review.activePatchsetId);
    if (patchset === undefined) return;
    // The SAME mint the round dispatch takes (#580/#587): it prefers the session already
    // HOLDING this review, so the front door's Current Checkout session is what the boards
    // are filed under — and `sessionIdForReview`, the read side of `board.read`, resolves
    // that same session back. Filed under anything else the boards would be undiscoverable.
    const session = (
      await enterRoundSession(
        sessionEntry,
        projectIdOf(review.repositoryRoot),
        review,
        gitForRepo(review.repositoryRoot),
      )
    ).session;
    const head = patchset.repository.headOid;
    await runBoardRegeneration(
      boardDraftingDeps(
        review,
        session,
        // No coding turn ran, so there is nothing to re-capture. `runBoardRegeneration`
        // only calls this when checkpoint evidence says the tree changed, which it never does here.
        async () => undefined,
        // No live channel: the round-progress log belongs to ROUNDS. Feeding a capture's
        // drafting into it would put a round the reviewer never dispatched in front of
        // them — and the client's round machine ignores every event before a `dispatched`
        // anyway, so it would be a lie that did not even render. The client learns the
        // boards arrived by re-reading `board.read` (`board-view.tsx`).
        () => undefined,
      ),
      {
        session,
        repoRoot: review.repositoryRoot,
        // The review's OWN patchset is the prior: nothing moved, so this drafts the first
        // generation over it rather than minting a successor to something that never ran.
        priorPatchsetId: review.activePatchsetId,
        asksDispatched: [],
        worked: { commitRange: { from: head, to: head }, diff: "", changedPaths: [] },
      },
    );
  }

  /** Kick {@link draftBoardsForReview} behind the command that opened the review — the
   *  swarm/scout post-commit-kick precedent. The capture has already returned; drafting
   *  runs behind it and its failure never surfaces as a failed capture. */
  const kickBoardDrafting = (review: Review): void => {
    void draftBoardsForReview(review).catch(() => undefined);
  };

  dispatch = createDispatch({
    service,
    allowedRoots,
    askLog: askLogStore,
    // R19 live push: after every ask-log append the handlers fan the fresh projection
    // to live clients (raw to loopback, scrubbed to projected). Absent-safe — a build
    // with no WS listener still writes durably; only the live push is skipped.
    broadcastAskProjection: (sessionId, projection) =>
      wsListener?.broadcastAskProjection(sessionId, projection),
    // Related-context retrieval (#461, B7): kicked at the REAL review-open
    // commands (capture / openPr), fire-and-forget — the kick's own promise
    // never rejects, both harness ports resolve failure-isolated (honest
    // council availability), and the tracker endpoints resolve off the
    // settings ladder (scout-detected offers under the global rung).
    onReviewOpened: (review) => {
      // The change's boards — the thing the reviewer came here to read. Kicked at the
      // review-open commands for the same reason related context is: opening a review is
      // when the material to read it by has to start being made.
      kickBoardDrafting(review);
      // The hook must never throw into the command path (`repoKeyOf` realpaths).
      try {
        void runRelatedContextRetrieval(review, {
          store: snapshotStore,
          resolveClaudePort: claudeAdapterForRepo,
          resolveCodexExecutor: codexExecutorForRepo,
          trackerConfig: resolveTrackerConfig(
            snapshotStore,
            repoKeyOf(review),
            daemonSettingsStore.readState().config,
          ),
        });
      } catch {
        // Retrieval is garnish on the open — a failed kick never surfaces here.
      }
    },
    // Revoking a device deletes its push token too, so a revoked device is silently
    // un-pushable (attention-notifications: "revoke stops pushes").
    pairing: {
      mint: () => pairingStore.mint(),
      exchange: (code, deviceName) => pairingStore.exchange(code, deviceName),
      listDevices: () => pairingStore.listDevices(),
      revokeDevice: (deviceId) => {
        pushTokenStore.delete(deviceId);
        const revoked = pairingStore.revokeDevice(deviceId);
        // Sever any live socket authorized as this device (#383 batch): a projected connection
        // cannot outlive the pairing it was authorized by — revoke means gone now, not next time.
        wsListener?.disconnectDevice(deviceId);
        return revoked;
      },
    },
    // `device.registerPush` set/delete, keyed by the connection's authenticated device id.
    pushTokens: {
      set: (deviceId, token, platform, disabledFamilies) =>
        pushTokenStore.set(deviceId, token, platform, disabledFamilies),
      delete: (deviceId) => pushTokenStore.delete(deviceId),
    },
    // `attention.acknowledge` clears + broadcasts through the live listener (late-bound).
    acknowledgeAttention: (selector) => wsListener?.acknowledgeAttention(selector) ?? 0,
    // Raise attention through the live listener (late-bound); returns the raised item's id so a
    // caller can clear exactly it (e.g. clearing ask-pending when its turn settles).
    raiseAttention: (event) => wsListener?.raiseAttention(event)?.id,
    // A review-scoped turn marks its review running for the duration (#383 batch) — the real
    // source of the projected `attention.running`, read by the listener's projection context.
    inFlightReviews,
    publishPort,
    submitPullRequest,
    // The write-enabled handoff turn (issue #18): brackets a live `claude` write turn
    // (fully capable, Bash included — Rai's call) with git checkpoints and returns the
    // turn diff. Reuses the SAME memoized `claude` discovery the review pipeline uses
    // (R2 subscription OAuth). Refuses a repo with submodules (Codex F6) and answers an
    // honest failed turn when no `claude` is installed — never a fabricated success.
    runHandoffTurn,
    // The round exit (B11 cluster 4): run the composed work-order as ONE coding-agent turn,
    // serialized per session behind any round already in flight for the review's target. The
    // session is SessionEntry's mint-or-reattach for that target (a stable id per target, so
    // two dispatches of one review serialize together), keyed by the review's PROJECT id with
    // its repo root stamped on (#580); a detached HEAD (no branch to claim) persists a
    // review-id session through the same store (#573). A failure-isolated
    // post-commit kick (the swarm/scout precedent): the turn runs behind the command, and its
    // rejection never surfaces — `round.dispatch` already returned the composed work-order.
    // The rounds-ledger read for `session.rounds`: project the live rounds runtime's ledger
    // for the review's session, resolved READ-ONLY (the read side of dispatchRound's mint
    // below — same target-claim derivation, never minting). An unknown review or a session
    // with no recorded round ⇒ an honest empty ledger.
    roundRecordsForReview: (reviewId: string) => {
      const review = service.reviewById(reviewId);
      if (!review) return [];
      return roundsRuntime.ledger(sessionIdForReview(review));
    },
    reportBoardForReview: async (reviewId: string, reportBoardId: string) => {
      const review = service.reviewById(reviewId);
      if (!review) return undefined;
      const sessionId = sessionIdForReview(review);
      const record = roundsRuntime
        .ledger(sessionId)
        .findLast((candidate) => candidate.reportBoard === reportBoardId);
      if (record === undefined) return undefined;
      return readRoundReportBoardForRecord(
        { record, sessionId, reportBoardId },
        {
          loadMeta: (boardId) => boardMetaStore.load(boardId),
          readElements: async (boardId) => [
            ...(await boardsRuntimeFor(review.repositoryRoot).service.getState(boardId)).values(),
          ],
        },
      );
    },
    // The display-transcript read for `session.transcript` (issue-set B): the coding-turn rows
    // the turn loop captured and persisted for this review's session, resolved READ-ONLY via the
    // SAME target-claim derivation the rounds read uses. Rows are stored raw and scrubbed at the
    // wire, so a loopback client reads its own host paths and a projected one never does.
    // Honest-empty when no turns were captured yet — the harness CLI stays the canonical owner and
    // this is an additive display read-model. The WRITE side is the session turn loop's
    // `recordTranscript` sink above, which every round-dispatched coding turn runs through.
    transcriptRowsForReview: (reviewId: string) => {
      const review = service.reviewById(reviewId);
      if (!review) return [];
      return transcriptStore.read(sessionIdForReview(review));
    },
    // The live round-progress catch-up read (C15 3.1). Keyed by review id — the same id the
    // run route's slug carries — so a cold `/s/:slug/run` mount folds the round already in
    // flight instead of showing an absent one. Honest-empty until a round dispatches.
    roundEventsForReview: (reviewId: string) => {
      const review = service.reviewById(reviewId);
      if (review === null) return [];
      const operation = roundOperationStore.read(sessionIdForReview(review));
      return operation === undefined
        ? roundProgress.read(reviewId)
        : [{ type: "operation", snapshot: roundOperationProgressSnapshot(operation) }];
    },
    // The sidebar's sessions (C03 cluster 2, bound in C18), served from the SAME durable
    // session store the round dispatch mints into — so a session the reviewer worked in is
    // the session the sidebar lists. Every write persists through the store, so a rename, a
    // pin, and an archive all survive reload; restore is un-archive.
    sessions: {
      list: () => sessionStore.list().map(sidebarSessionFor),
      // The New Chat front door (C21, #587): starting a session is ONE act — capture what
      // changed on the clicked target, mint, claim, attach — and the HOST owns all of it.
      //
      // Two things the client structurally cannot do, which is why this is not a renderer
      // sequence. It cannot make the steps atomic: a capture that rejects after the mint
      // would leave a claim standing over a review-less session, and the claim hides the
      // very row that would retry it. And it cannot resolve WHICH repo a row belongs to,
      // because `LocalWork` carries an `owner/name` identity and no path (R19) while
      // `Project.openPath` is "the repo, or the FIRST included repo".
      //
      // So: resolve the repo from the row's identity, capture, and only THEN mint. A
      // rejected capture has claimed nothing and the row stays clickable.
      start: async ({ projectId, commandId, target }) => {
        const project = projectStore.list().find((entry) => entry.id === projectId);
        // WHICH repo this row named. Absent target (the Current Checkout row) is the project
        // as a whole, which is exactly what `openPath` means; a target resolves through its
        // identity. A miss falls back to the default root ONLY when it is unambiguous (a
        // single-repo project, or a legacy row) — in a multi-repo workspace `resolveCaptureRoot`
        // refuses rather than capture the wrong repo under this row's label, and the rejection
        // (before the mint) leaves the row clickable.
        const resolvedRoot =
          target?.repository === undefined
            ? undefined
            : await repoRootForIdentity(project, target.repository);
        const rootDecision = resolveCaptureRoot(project, target?.repository, resolvedRoot);
        if ("error" in rootDecision) throw new Error(rootDecision.error);
        const root = rootDecision.root;
        // Cleared before the capture, not after (the `checkFreshness` rule): this front
        // door is reachable on an ALREADY-OPEN project, whose root is watched and settled,
        // so an edit made while the capture runs must survive as dirty.
        if (target === undefined) watcher.setDirty(false);
        // Capture BEFORE the mint, so a rejection claims nothing.
        const review = await (target === undefined
          ? service.capture(commandId, root)
          : target.prNumber === undefined
            ? captureBranch(commandId, root, target.branch, project?.primaryBranch ?? "HEAD")
            : openPullRequest(
                commandId,
                `${target.repository ?? ""}#${target.prNumber}`,
                root,
                false,
              ));
        allowedRoots.add(review.repositoryRoot);
        if (target === undefined) {
          // The working-tree capture is the one that IS watched for freshness — the branch
          // and PR ranges are pinned snapshots and stay off the watcher deliberately.
          watcher.start(review.repositoryRoot, locusForRepo(review.repositoryRoot));
        }
        // The claim-less checkout session still stamps its repo root, so its rounds stay in
        // that repo's ledger; `reviewId` (attached below) is what resolves them back to it.
        const entered =
          target === undefined
            ? {
                session: {
                  ...mintSession(projectId),
                  repositoryRoot: review.repositoryRoot,
                },
                reattached: false,
              }
            : sessionEntry.enter(projectId, target, review.repositoryRoot, review.id);
        if (!entered.reattached) sessionStore.save(entered.session);
        // Attach, and REPORT WHAT THE STORE HOLDS. `attachReview` keeps an existing review
        // (a session attaches at most one), so a session already bound to another review
        // comes back carrying THAT one and the client lands where the diff actually is —
        // rather than being told this capture succeeded when nothing points at it.
        const bound = sessionStore.attachReview(entered.session.id, review.id) ?? entered.session;
        // Draft this change's boards. The front door captures through `service.capture` /
        // `captureBranch` / `openPullRequest` DIRECTLY rather than through the `review.*`
        // dispatch, so `onReviewOpened` never fires for it — and New Chat is the only
        // front door the shipping app has. Kicked AFTER the attach, so the session the
        // boards file under is the one the row just bound the review to.
        kickBoardDrafting(review);
        return { session: sidebarSessionFor(bound), reattached: entered.reattached };
      },
      rename: (sessionId, title) => {
        const session = sessionStore.rename(sessionId, title);
        return session && sidebarSessionFor(session);
      },
      setPinned: (sessionId, pinned) => {
        const session = sessionStore.setPinned(sessionId, pinned);
        return session && sidebarSessionFor(session);
      },
      setArchived: (sessionId, archived) => {
        const session = archived
          ? sessionStore.archive(sessionId)
          : sessionStore.restore(sessionId);
        return session && sidebarSessionFor(session);
      },
    },
    // The lens-board read for `board.read` (C05 cluster 8, C18): the board this review's
    // session drafted for `(generation, lens)`, rebuilt from its two durable halves — the
    // board-meta record (which board id, and the board-level coverage the element
    // vocabulary cannot carry) and the whiteboard event log's projected element state.
    // Session identity is the SAME read-only target-claim derivation the rounds/transcript
    // reads use. No meta record ⇒ that lens drafted no board that generation ⇒ honest
    // missing, never a fabricated board.
    lensBoardForReview: async (reviewId: string, generation: string, lens: LensKind) => {
      const review = service.reviewById(reviewId);
      if (!review) return undefined;
      const storedGeneration = generationStore.load(generation);
      if (
        storedGeneration === undefined ||
        !review.patchsets.some((patchset) => patchset.id === storedGeneration.patchsetId)
      ) {
        return undefined;
      }
      const sessionId = sessionIdForReview(review);
      const meta = generationBoardMeta(
        storedGeneration,
        boardMetaStore.listForGeneration(sessionId, generation),
        lens,
      );
      if (!meta) return undefined;
      const state = await boardsRuntimeFor(review.repositoryRoot).service.getState(meta.boardId);
      return projectLensBoard([...state.values()], {
        lens,
        generation,
        boardId: meta.boardId,
        document: meta.document,
        skippedHunks: meta.skippedHunks,
      });
    },
    lensAbsenceForReview: async (reviewId: string, generation: string, lens: LensKind) => {
      const review = service.reviewById(reviewId);
      if (!review) return undefined;
      const stored = generationStore.load(generation);
      if (
        stored === undefined ||
        !review.patchsets.some((patchset) => patchset.id === stored.patchsetId)
      ) {
        return undefined;
      }
      return stored.absentLenses?.[lens];
    },
    queueRoundIfActive: async ({ review, dispatchId }) => {
      const session = (
        await enterRoundSession(
          sessionEntry,
          projectIdOf(review.repositoryRoot),
          review,
          gitForRepo(review.repositoryRoot),
        )
      ).session;
      for (;;) {
        const active = roundOperationStore.read(session.id);
        if (active === undefined || isRoundOperationTerminal(active)) return false;
        if (active.dispatchId === dispatchId || active.rerunRequested) return true;
        try {
          publishRoundOperation(
            roundOperationStore.requestRerun({
              sessionId: active.sessionId,
              operationId: active.operationId,
              revision: active.revision,
            }),
          );
          return true;
        } catch (error) {
          if (!(error instanceof RoundOperationConflictError)) throw error;
        }
      }
    },
    dispatchRound: async ({ review, workOrder, dispatchId, sourcePatchsetId, askOccurrences }) => {
      const session = (
        await enterRoundSession(
          sessionEntry,
          projectIdOf(review.repositoryRoot),
          review,
          gitForRepo(review.repositoryRoot),
        )
      ).session;
      await coordinator.submit(
        createRoundOperation({
          session,
          review,
          workOrder,
          dispatchId,
          sourcePatchsetId,
          askOccurrences,
        }),
      );
      return { askDrain: "coordinator" };
    },
    // The living-draft span-rework producer (B11 cluster 5): a one-shot model turn that
    // reworks one staged ask's body per the reviewer's instruction, on WHICHEVER seat the
    // council resolves — the SAME refine harness `refineComment` runs on. `review.reviseSpan`
    // serializes these per review, re-anchors the span by quote match, and lands the result
    // through the durable ask log. Degrades to an honest `unavailable` when neither seat is
    // installed. Posts NOTHING — it stages a revised ask exactly like a hand edit.
    // ponytail: reuses the refine turn with the instruction+span composed into the note; a
    // dedicated revise prompt is the quality upgrade path, not a correctness gap.
    reworkSpan: async ({ review, type, span, instruction, path }) =>
      createLiveRefinePort({
        claudePort: claudeAdapterForRepo,
        codexExecutor: codexExecutorForRepo,
      })({
        review,
        type,
        raw: `Revise this text as instructed — "${instruction}":\n\n${span}`,
        ...(path ? { path } : {}),
      }),
    chooseRepository,
    openPullRequest,
    captureBranch,
    startWatching: (root: string) => watcher.start(root, locusForRepo(root)),
    isRepositoryDirty: () => watcher.isDirty(),
    setRepositoryDirty: (value: boolean) => watcher.setDirty(value),
    // The front door (issue #29): the persisted projects list, read-only discovery
    // over the chosen path, and the ambient harness detection. MAIN derives the
    // stored project shape from the confirmed discovery so the renderer cannot
    // desync it.
    projects: {
      list: () => projectStore.list(),
      add: (input) => {
        const draft = deriveProjectDraft(input.discovery, input.includedRepos, input.primaryBranch);
        const project = projectStore.add(draft);
        return { project, projects: projectStore.list() };
      },
      remove: (input) => {
        projectStore.remove(input.projectId);
        return { projects: projectStore.list() };
      },
      rename: (input) => ({
        // The store owns the R67 restore rule: an emptied name writes back the project's
        // own `org/repo` identity rather than persisting a blank.
        project: projectStore.rename(input.projectId, input.name) ?? null,
        projects: projectStore.list(),
      }),
    },
    // The initial context dump (issue #29, wireframe #2): build every included
    // repo's ProjectSnapshot at the CONFIRMED primary branch, streaming the real
    // generator stages as live narration. Extracted to `process-project.ts` so the
    // branch-selection + real-count wiring is unit-tested off-Electron.
    processProject: async (input, emit) => {
      const result = await processProjectCore(input, emit);
      // The Repo Map now exists for this project — start (idempotently) keeping it
      // warm as its reference branch advances. Fire-and-forget: never delays the
      // processing response, and a start failure can only leave the map un-warmed,
      // never break the process.
      const processed = projectStore.list().find((entry) => entry.id === input.projectId);
      if (processed) {
        void rehydration?.ensureForProject(processed);
        // The project scout (#461 §4, B7): runs at project add and on every
        // re-process (re-runnable — determinism recomputes, the seat never
        // overwrites detected facts). Fire-and-forget like the rehydration kick.
        const scoutRoot = processed.openPath || processed.path;
        void projectScoutRuntime.runForRepo({
          projectId: processed.id,
          repoKey: repoKeyForRoot(scoutRoot),
          repoRoot: scoutRoot,
        });
      }
      return result;
    },
    discoverProject: ({ path, kind }) =>
      discoverProject(defaultProjectDiscoveryDeps(gitForRepo(path)), path, kind),
    // Rule Zero: the ungated filesystem browser. No allowedRoots assertion here —
    // it's the picker that produces paths for the gated commands, not one itself.
    listDir: (input) => listDir(input, defaultFsListDirDeps()),
    detectHarnesses,
    detectForges,
    github: githubAccount,
    // Project detail (issue #37): the unified smart list's substrate. The LOCAL half
    // is real worktrees/branches with dirty/ahead/behind from git; the live GitHub
    // OPEN-PR set rides the same boundary through the auth-ladder PR source (absent
    // when auth is unavailable → the local-only list, with `authUnavailable` naming the
    // reason). An unknown projectId degrades to an empty detail (fail-safe, mirroring
    // the project store) rather than throwing.
    projectDetail: async (projectId, prStates, localOnly, emit) => {
      const project = projectStore.list().find((entry) => entry.id === projectId);
      if (!project) {
        return { viewer: { login: "you" }, locals: [], prs: [], truncated: false };
      }
      const projectRoot = project.openPath || project.path;
      // Local-first instant paint: no auth, no PR fetch, no network — just git.
      // The renderer fires this first so the work already on disk shows immediately,
      // never blocked behind a slow (or dead-token, failing) GitHub round-trip.
      if (localOnly) {
        return loadProjectDetail(
          defaultProjectDetailSourceDeps(gitForRepo(projectRoot)),
          project,
          prStates,
        );
      }
      const { source, authUnavailable } = await resolveProjectPrSource();
      const detail = await loadProjectDetail(
        defaultProjectDetailSourceDeps(gitForRepo(projectRoot), source ?? undefined),
        project,
        prStates,
        emit,
      );
      return authUnavailable ? { ...detail, authUnavailable } : detail;
    },
    // The reviewed PR's worktree + setup status (historical-PR review). Honest
    // reads over MAIN's own index and the worktree's status files; a review with
    // no worktree — or one whose checkout has since been deleted — returns null.
    prWorktree: async (reviewId) => {
      const entry = readPrWorktreeIndex()[reviewId];
      if (!entry || !existsSync(entry.path)) return null;
      return {
        path: entry.path,
        setup: readSetupStatus(entry.path),
        logTail: readSetupLogTail(entry.path),
      };
    },
    // The merged-PR row's clean-up (B2), for real: `git worktree remove <path>` run
    // from the project's root. Non-forcing — a dirty worktree is refused and reported
    // ok:false, never swept. The `worktreeId` is the worktree path (LocalWork.id).
    cleanupWorktree: async ({ projectId, worktreeId }) => {
      const project = projectStore.list().find((entry) => entry.id === projectId);
      const projectRoot = project ? project.openPath || project.path : null;
      if (!projectRoot) return { ok: false };
      return cleanupWorktree(
        {
          git: gitForRepo(projectRoot),
          resolveProjectRoot: async () => projectRoot,
        },
        { projectId, worktreeId },
      );
    },
    // ── The Context Map surface (change add-context-map-view) ─────────────────
    // Pure read of the persisted Repo Map: resolve the project's repoKey exactly as
    // the store writes it, gate the stored tip fresh, then serve queryProjectMap +
    // the local knowledge set verbatim. No rebuild, no model spend.
    projectContextMap: async (projectId) => {
      const project = projectStore.list().find((entry) => entry.id === projectId);
      const projectRoot = project ? project.openPath || project.path : null;
      if (!projectRoot) return { status: "absent", reason: "unknown project" };
      const repoKey = repoKeyForRoot(projectRoot);
      const manifest = liveSnapshotStore.loadManifest(repoKey);
      if (!manifest) {
        return {
          status: "absent",
          reason:
            "no repo map is persisted for this project yet — process the project or run `rennet map`",
        };
      }
      const gated = new ProjectContextReader(liveSnapshotStore).loadFresh(
        repoKey,
        manifest.baseOid,
      );
      if (!gated.ok) return { status: "absent", reason: gated.failure.reason };
      // Project the stored knowledge through the gated snapshot: a statement whose
      // cited bytes the current map changed is invalidated, and must NOT be served as
      // an active/current claim (that would render stale knowledge as fresh). We serve
      // only the resolving statements; the UI badge discloses when the set lags the map.
      // ponytail: invalidatedPending is dropped from the view, not yet surfaced as a
      // distinct "pending re-check" tier — add that when the protocol carries it.
      const storedSet = new KnowledgeStore(liveSnapshotStore).loadLocal(repoKey);
      const knowledge = storedSet
        ? { ...storedSet, statements: [...queryKnowledge(storedSet, gated.snapshot).statements] }
        : null;
      return {
        status: "ok",
        map: queryProjectMap(gated.snapshot),
        knowledge,
      } as ProjectContextMapResult;
    },
    // Project-scoped context ask: the SAME engine context.ask runs for a review,
    // keyed at the persisted tip. The backend owns every honest failure state
    // (absent harness, snapshot refusal) — this wiring only supplies the project's
    // resolve closure and the user's own harness port.
    projectContextAsk: async ({ projectId, question, scope }) => {
      const project = projectStore.list().find((entry) => entry.id === projectId);
      const projectRoot = project ? project.openPath || project.path : null;
      if (!projectRoot) {
        return {
          status: "failed",
          failureReason: "unknown project",
          cost: {
            turns: 0,
            model: null,
            effort: null,
            budgetGranted: true,
            overage: false,
            resolution: null,
          },
        };
      }
      const repoKey = repoKeyForRoot(projectRoot);
      const backend = contextAskBackend({
        reader: new ProjectContextReader(liveSnapshotStore),
        knowledgeStore: new KnowledgeStore(liveSnapshotStore),
        resolve: () => ({
          repoKey,
          baseOid: liveSnapshotStore.loadManifest(repoKey)?.baseOid ?? "",
        }),
        resolvePort: async () => {
          const { locus, distroCwd } = locusContextForRepo(projectRoot);
          return (await getClaudeHarness(locus, distroCwd)).adapter;
        },
        repoRoot: projectRoot,
      });
      return backend.ask({
        question,
        ...(scope === undefined ? {} : { scope }),
      }) as Promise<ProjectContextAskResult>;
    },
    // The human-confirm surface (R54): flip one statement's status by id and persist
    // the whole set atomically. Map preserves the deterministic id order; the claim
    // is never edited, so the content-hash id stays stable.
    knowledgeDisposition: async ({ projectId, statementId, disposition }) => {
      const project = projectStore.list().find((entry) => entry.id === projectId);
      const projectRoot = project ? project.openPath || project.path : null;
      if (!projectRoot) return { status: "not-found", statementId };
      const repoKey = repoKeyForRoot(projectRoot);
      const knowledgeStore = new KnowledgeStore(liveSnapshotStore);
      const set = knowledgeStore.loadLocal(repoKey);
      const statement = set?.statements.find((entry) => entry.id === statementId);
      if (!set || !statement) return { status: "not-found", statementId };
      const updated = { ...statement, status: disposition };
      knowledgeStore.save(repoKey, {
        ...set,
        statements: set.statements.map((entry) => (entry.id === statementId ? updated : entry)),
      });
      return { status: "ok", statement: updated } as KnowledgeDispositionResult;
    },
    // The Flagged lens (issue #138): the automated review layer's findings. This is
    // the LIVE finding-generation runner (#32) — a real model turn over the review's
    // diff. Dual-review aggregation (#41) + per-finding verification (#179) run by
    // DEFAULT now (Rai's mandate, 2026-08-11); an explicit opt-down gives single-Claude
    // quick. The boundary is unchanged.
    flaggedReview: runFlaggedReview,
    // The Noise lens (issue #34): the low-signal churn grouped away, each group tagged
    // rule vs noise job. This is the LIVE noise-classification runner — a real model
    // turn over the review's diff, replacing the fixture, behind the unchanged
    // `noiseReview` boundary. The deterministic mechanical-rules engine (a separate
    // admission authority for the `rule` groups) is a DEFERRED follow-up; the empty-
    // vs-failed distinction and the totality-floor ejection are honoured today.
    noiseReview: runNoiseReview,
    // The Spec angle's live source (wireframes #9): parse-on-open of the change the
    // reviewed patchset selected, read from the review's checked-out root. Deterministic
    // and model-free — no gate, no spend. `null` when the review touches no
    // `openspec/changes/<name>/`, replacing the frozen fixture with the real change.
    openSpecChange: (review) => {
      const patchset = activePatchset(review);
      return readOpenSpecChange(patchset, gitForRepo(patchset.repository.root));
    },
    // The Spec view's requirement→hunk coverage (wireframes #9 / R53): the produced
    // mapping a budget-gated model turn grounds against the offered hunks. `null` (no
    // change) or `status:"failed"` (no seat / refusal / failed turn) ⇒ no chips.
    openSpecCoverage: runLiveCoverage,
    // review.ask (issue #139, bead workspace-alqow): the LIVE ports a review
    // question reaches. The core `askReview` router (invoked in dispatch) still owns
    // the orchestrator-once / both-adds-codex / never-synthesize law; these ports are
    // now the REAL invocation behind that law (replacing `reviewAskFixturePorts()`):
    //   • askOrchestrator runs ONE capable `claude` turn at the review's repository
    //     root, grounded in the active patchset's diff and free to read the repo.
    //     The ask's model spend is that single turn, not a fresh lens review.
    //   • askCodex shells one `codex exec` over the diff + question (gated on the
    //     honestly-probed `codex` availability; an absent binary yields a legible
    //     "unavailable" answer, never a crash, so a "both" ask still returns the
    //     orchestrator's answer).
    // review.symbolLookup (Rai, wireframes #8): the LIVE symbol inspector port. It
    // reads the review's OWN model-free symbolic surface (context.symbol +
    // context.references) over a freshly composed backend — deterministic index
    // reads, NO model spend. Dispatch resolves + freshness-pins the review before
    // calling this, so the backend is built for the addressed review's active
    // patchset. The pipeline is a deterministic-floor build (no lens/model turns).
    symbolLookup: createLiveSymbolLookup({
      buildBackend: async (review) => {
        // Pin to the REVIEWED tree (base..head), not the base — so a symbol added,
        // renamed, or moved in the PR resolves instead of reading stale/missing over
        // the base snapshot. The pipeline is a deterministic-floor build; only the
        // symbolic ops (context.symbol/references) are read from this backend.
        const headReview = reviewPinnedToHead(review);
        const pipeline = await buildReviewCanvases({
          reviewId: headReview.id,
          patchset: activePatchset(headReview),
          dispositions: headReview.dispositions,
          budget: createInvocationBudget(0),
        });
        const live = await createDesktopReviewBackend(headReview, pipeline, {
          resolveKnowledgePort: async (repoRoot) => {
            const { locus, distroCwd } = locusContextForRepo(repoRoot);
            return (await getClaudeHarness(locus, distroCwd)).adapter;
          },
          noveltyLifecycle: liveNoveltyLifecycle,
        });
        return live.backend;
      },
    }),
    // review.openInEditor (Rai, wireframes #8): open a review file AT ITS LINE. Try a
    // line-jumping editor CLI (`<cli> -g file:line`, VS Code / Cursor / Sublime
    // family) first; fall back to an OS-level open (no line) only when none took it.
    // Path resolution + the escape-the-root refusal live in `performOpenInEditor`.
    openInEditor: ({ review, path, line }) =>
      performOpenInEditor(editorLaunchEffects, {
        repositoryRoot: review.repositoryRoot,
        path,
        line,
        locus: locusForRepo(review.repositoryRoot),
      }),
    // review.ask — BOTH live legs (F1, #570). The orchestrator runs ONE capable
    // `claude` turn at the review's repository root through the same
    // `claudeHandoffRunPort` the write handoff uses (no second drain loop, no
    // checkpoint bracket — an ask has no diff to measure), streaming its text
    // deltas out through dispatch. No harness ⇒ an honest line naming `claude`.
    reviewAsk: createLiveReviewAskPorts({
      askOrchestrator: createLiveOrchestratorAsk({
        resolveRunPort: async (repoRoot, review) => {
          const adapter = await claudeAdapterForRepo(repoRoot);
          if (!adapter) return null;
          if (review) {
            const sessionId = sessionIdForReview(review);
            if (sessionStore.load(sessionId)) {
              return turnLoopRunPort(turnLoopForRepo(repoRoot, adapter), sessionId);
            }
          }
          return claudeHandoffRunPort(adapter);
        },
        askLogIdForReview: (review) => review.id,
        toolsForReview: () => buildAppTools((name, input, ctx) => dispatch(name, input, ctx)),
      }),
      askCodex: async ({ review, question, abortController }) => {
        // The ask executor is bound to the RESOLVED absolute codex, same as the
        // pipeline seat (bead workspace-6qp15), and to the review's locus (#334) so a
        // WSL project asks the distro's codex. A null executor means no codex resolved
        // — surface that honestly rather than shelling a bad `codex`.
        const executor = await codexExecutorForRepo(review.repositoryRoot);
        if (executor === null) {
          return {
            model: CODEX_ASK_LABEL,
            answer: "Codex is not installed, so no second opinion is available.",
          };
        }
        // Thread the quit-abort controller (#251 criterion 4) → execa's cancelSignal.
        return createLiveCodexAsk({ executor })({
          review,
          question,
          ...(abortController ? { abortController } : {}),
        });
      },
    }),
    // The live-turn registry (#251 criterion 4): dispatch registers each ask turn's
    // AbortController; `before-quit` reaps whatever is still in flight.
    liveTurns,
    // review.refine (issue #19): the LIVE comment-refinement producer. Rai's
    // headline feature — a rough note refined into a clean comment by a real,
    // council-routed model turn. Runs on WHICHEVER seat the council resolves: Codex
    // (Terra) when installed — the same absolute-binary resolution the ask-AI
    // executor and pipeline seat use (bead workspace-6qp15) — else the Claude
    // adapter (a light read-only session with the inline schema, the same
    // structured-output mechanism every pipeline lens seat uses; no docType).
    refineComment: createLiveRefinePort({
      claudePort: claudeAdapterForRepo,
      codexExecutor: codexExecutorForRepo,
    }),
    // review.draftPrBody (issue #74, M26): the LIVE PR-body drafting producer. The
    // own-branch destination's paper opens with an HONEST ACCOUNT of the change,
    // drafted by a real, council-routed model turn. Runs on WHICHEVER seat the
    // council resolves for `pr-body-draft` (Codex Luna when installed, else the
    // Claude adapter) — the SAME seat probes the refine producer uses (bead
    // workspace-6qp15). Degrades to an honest `unavailable` (the deterministic
    // composed body still previews) when neither seat is installed. Posts NOTHING.
    draftPrBody: createLiveDraftPrBodyPort({
      claudePort: claudeAdapterForRepo,
      codexExecutor: codexExecutorForRepo,
    }),
    // review.deltaDigest (issue #73 / M25): the LIVE delta re-review digest producer.
    // Rephrases the successor review's DETERMINISTIC successor account into a one-glance
    // TL;DR shown ON TOP of the facts, on WHICHEVER seat the council resolves for
    // `delta-rereview-summary` — the SAME probes the drafter uses. Degrades to an honest
    // `unavailable` (the facts still render, no headline) when neither seat is installed.
    // Fed ONLY the structured account, it can add no fact the facts don't carry. Posts
    // NOTHING and gates nothing.
    draftDeltaDigest: createLiveDeltaDigestPort({
      claudePort: claudeAdapterForRepo,
      codexExecutor: codexExecutorForRepo,
    }),
    // #251 / #382 M2 finding 5 re-attach: reload the persisted threads AND the turns still
    // genuinely streaming in this surviving main process. A turn still LIVE in the registry is
    // NOT interrupted — the crash-recovery transform in `loadThreads` painted its placeholder
    // `interrupted`, so drop that placeholder and report the turn in `inFlight` (with its real
    // coalesced body) instead, letting the phone resume the live cursor. Only a turn whose main
    // process actually died stays `interrupted`. `channelKey` matches the persisted placeholder
    // id (`${turnId}::orchestrator`) the reducer would otherwise fold as a stopped turn.
    reattachThreads: async ({ reviewId }) => {
      const inFlight = liveTurns.inFlightFor(reviewId);
      const liveIds = new Set(inFlight.map((t) => `${t.turnId}::${t.channel}`));
      const threads = threadStore.loadThreads(reviewId).map((thread) => ({
        ...thread,
        messages: thread.messages.filter((m) => !liveIds.has(m.id)),
      }));
      return { threads, inFlight };
    },
    // #251 persistence: the write side of durability — a streaming placeholder on disk
    // before the turn runs (recovers as interrupted on a kill), replaced by the durable
    // answer on completion.
    threadPersistence: {
      upsertThread: (input) => threadStore.upsertThread(input.reviewId, input),
      putMessage: (input) => threadStore.putMessage(input.reviewId, input.threadId, input.message),
    },
    // The handoff-bundle composer (issue #72, M24): the light-tier authoring step over
    // the mechanical bundle. Council-routed over the SAME probes the refiner uses
    // (claude adapter + codex executor); one batched turn, exec-free (read-only). No
    // seat installed ⇒ the core router returns the mechanical floor.
    composeBundle: composeRoundBundle,
    // The settings surface (wireframe #15): the config ladder over the REAL stores.
    // `get` resolves the global appearance layer (`~/.rennet/config.json`) plus every
    // project's repo-scope visibility/promotion (its `~/.rennet/projects/<key>/
    // config.json`), each with provenance from the pure core resolver. `guidance`
    // reads one project's `.rennet/conventions.json` house rules read-through.
    // `setAppearance` writes only the app-side config (no repo write). `setRepoVisibility`
    // runs the REAL map-visibility switch (the repo's Rennet-owned `.rennet/.gitignore`).
    // The config-ladder composition (extracted to `./settings` so its logic is
    // unit-tested off-Electron). MAIN injects the real effects: git top-level
    // resolution (the same identity the snapshot generator keys on), legacy-
    // workspace rediscovery, the two stores, the guidance reader, and the real
    // visibility switch. The malformed refusals live in the stores themselves.
    settings: createSettingsComposition({
      listProjects: () => projectStore.list(),
      loadConfigState: (repoKey) => snapshotStore.loadConfigState(repoKey),
      readGlobalState: () => clientSettingsStore.readState(),
      updateGlobal: (update) => clientSettingsStore.update(update),
      // This host's daemon-settings — the local host's global rung, the only one
      // locally readable; remote/WSL hosts keep theirs on that host (#476, §4.2).
      readDaemonSettings: () => daemonSettingsStore.read(),
      // The tracker section (#461, B7) is a global-rung host fact, so it writes to
      // daemon-settings — the same store `resolveTrackerConfig` reads it back from.
      updateDaemon: (update) => daemonSettingsStore.update(update),
      // Paired devices are the source for project-less remote hosts on the surface
      // (#476, finding 9) — a device paired before its first project is still listed.
      listPairedDevices: () => pairingStore.listDevices(),
      // Ask ONE host's daemon whether it is running, for the host cards (C17, #485).
      probeDaemon: (source) => probeDaemonForHost(source, dataDir, serverVersion),
      // The same handshake, on demand, behind Reconnect (C17 cluster 5, #533) — throwing the
      // reason for a host kind this daemon cannot reach at all.
      reconnectDaemon: (source) => reconnectDaemonForHost(source, dataDir, serverVersion),
      // The version a host's daemon would update TO — served ONLY for a host Rennet can
      // actually update (review finding 5). A WSL distro can be updated when this daemon has a
      // bundle to deliver; this machine's daemon ships with the app and a paired device
      // updates itself, so neither gets an `updateAvailable` flag whose button could only fail.
      latestDaemonVersionFor: (source) =>
        source.startsWith("wsl:") && options.hostBundlePath ? serverVersion : undefined,
      // Ask ONE host which coding agents are installed on IT (C17 cluster 3, #485).
      detectHarnessesOn,
      // …and which forge CLIs it has (C17 amendment B), so a WSL card shows its own `gh`.
      detectForgesOn,
      // The real per-host daemon update behind Update Daemon (C17 cluster 6, #534). A host
      // kind with no mechanism throws its reason, so the card never reads a fake success.
      updateDaemonOn: updateDaemonForHost,
      gitTopLevel: async (workingPath) => {
        let topLevel: string;
        try {
          topLevel = (
            await gitForRepo(workingPath)(workingPath, ["rev-parse", "--show-toplevel"], {
              reject: true,
            })
          ).trim();
        } catch (error) {
          if (error instanceof LocusDistroMismatchError) throw error;
          return null;
        }
        if (!topLevel) return null;
        try {
          const locus = locusForRepo(workingPath);
          const hostTopLevel =
            locus.kind === "wsl" && topLevel.startsWith("/")
              ? toWindowsView(topLevel, locus.distro)
              : topLevel;
          return realpathSync(hostTopLevel);
        } catch {
          return null;
        }
      },
      discoverWorkspaceRepos: async (project) => {
        const result = await discoverProject(
          defaultProjectDiscoveryDeps(gitForRepo(project.path)),
          project.path,
          "workspace",
        );
        return result.repos.map((repo) => repo.path);
      },
      loadGuidance: (repoRoot) => loadConventionCatalogue(repoRoot),
      applyVisibility: async ({ repoKey, repoRoot, target }) => {
        const preview = await applyVisibilitySwitch(
          snapshotStore,
          repoKey,
          repoRoot,
          target,
          gitForRepo(repoRoot),
        );
        return { changed: preview.changed, gitignorePath: preview.gitignorePath };
      },
      // The repo rung of the settings ladder (C18 group A): one pref written into the
      // project's own `config.json`. `updateConfig` REFUSES a malformed file (Rule 75),
      // so a corrupt config is never clobbered by an edit.
      writeRepoValue: ({ repoKey, field, value }) => {
        snapshotStore.updateConfig(repoKey, (current) => withRepoPref(current, field, value));
      },
      // The scout's DETECTED offers for the row's provenance — the SAME offers
      // `resolveTrackerConfig` folds, so the chip names the layer retrieval used.
      scoutOffers: (repoKey) => scoutSettingsOffers(snapshotStore, repoKey),
      // The guidance WRITER beside the reader: the repo's own `.rennet/conventions.json`.
      saveGuidance: (repoRoot, rules) => saveConventionCatalogue(repoRoot, rules),
      clearRepoValue: ({ repoKey, field }) => {
        // Drop a repo-scoped field so the value falls back down the ladder (Reset).
        // `updateConfig` refuses a malformed file (Rule 75), so nothing is clobbered.
        snapshotStore.updateConfig(repoKey, (current) => {
          const next: Record<string, unknown> = { ...current };
          delete next[field];
          return next as unknown as typeof current;
        });
      },
    }),
  });

  // The loopback WS transport (#378). Started here — after dispatch exists — and
  // awaited so `createRennetServer` resolves only once the socket is `listening`,
  // giving the desktop shell a real `wsPort` before it loads the window.
  wsListener = await startWsListener({
    dispatch,
    serverVersion,
    // Non-loopback (remote) connections present a device token; verify it against the store.
    verifyDeviceToken: (token) => pairingStore.verifyToken(token),
    // The attention system (issue #383 M1): advertising `attention`, accepting presence, and
    // planning pushes off the registered tokens. Present ⇒ M1 delivery; the egress defaults to
    // the real Expo call. Dead tokens the service reports are pruned from the store.
    attention: {
      pushTokens: {
        list: () => pushTokenStore.list(),
        delete: (deviceId) => pushTokenStore.delete(deviceId),
      },
    },
    // This build wires the M2 acting seams (`review.interrupt` via the live-turn registry,
    // `publish.compose`), so it advertises `act` — a phone renders Stop and the publish surface
    // truthfully instead of showing controls that silently no-op against a pre-M2 daemon.
    act: true,
    // The R19 projection context: every host root the server could name — the granted
    // roots ∪ every stored project path — rebuilt per request so a new project is
    // referenceable at once. Loopback connections never consult it.
    projectionContext: () => {
      const roots = new Set<string>(allowedRoots);
      for (const project of projectStore.list()) {
        roots.add(project.path);
        roots.add(project.openPath);
        for (const repoPath of project.includedRepoPaths ?? []) roots.add(repoPath);
      }
      // `reviewIsRunning` feeds the projected review's `attention.running` (#383 batch); the
      // listener adds `reviewNeedsYou` from its own attention registry when attention is on.
      return {
        ...buildProjectionContext(roots, homedir()),
        reviewIsRunning: (reviewId) => inFlightReviews.has(reviewId),
      };
    },
    // Opt-in bind beyond loopback (default stays 127.0.0.1:0).
    listen: daemonSettingsStore.read().daemon?.listen,
    // The served browser UI (#381); absent ⇒ headless.
    uiDist: options.uiDist,
  });

  void coordinator.recover().catch((error) => {
    console.error("Durable round recovery failed", error);
  });

  let didShutdown = false;
  const shutdown = (): void => {
    // An in-flight device-flow poll must not outlive the server.
    deviceFlow?.controller.abort();
    deviceFlow = null;
    // The old before-quit order (#251 criterion 4): signal in-flight turns, close the
    // watcher, close rehydration, close the store. Idempotent — Electron can fire quit twice.
    // The WS listener closes last, dropping every client socket.
    if (didShutdown) return;
    didShutdown = true;
    liveTurns.abortAll();
    void watcher.close();
    rehydration?.closeAll();
    store?.close();
    pushTokenStore.close();
    roundOperationStore.close();
    void wsListener?.close();
  };
  return {
    dispatch,
    shutdown,
    wsPort: wsListener.port,
    wsHost: wsListener.host,
    boardsRuntimeFor,
  };
}
