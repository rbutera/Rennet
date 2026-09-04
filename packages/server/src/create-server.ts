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
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AskLogStore,
  applyVisibilitySwitch,
  BoardMetaStore,
  CLAUDE_TESTED_RANGE,
  type ClaudeHarnessResult,
  type CodexAvailability,
  captureRangePatchset,
  cleanupWorktree,
  createClaudeCiRefinementTurn,
  createClaudeHarness,
  createClientSettingsStore,
  createCodexCiRefinementTurn,
  createCodexExecutor,
  createCodexHarness,
  createDaemonSettingsStore,
  createGitHubOctokit,
  createGitHubProjectPrSource,
  createGitLabPrSubmissionAdapter,
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
  discoverProject,
  discoverWorktreeIdentities,
  ensureManagedClone,
  ensureProjectSnapshotPin,
  ensurePrWorktree,
  execaGitFor,
  executeExternalCommand,
  FileProjectStore,
  type ForgeDetectionDeps,
  GenerationStore,
  GITHUB_REQUEST_TIMEOUT_MS,
  GitCaptureAdapter,
  type GitExec,
  GitHubChangesetSource,
  type GitHubCliTokenResult,
  GitHubForgeAdapter,
  GitHubPrSubmissionAdapter,
  GitHubPublishAdapter,
  GitLabForgeAdapter,
  type GitLabForgeCommandRunner,
  type GitLabPrSubmissionCommandRunner,
  gitForRepoFactory,
  instrumentCodexExecutor,
  isGitHubNetworkError,
  listDir,
  loadConventionCatalogue,
  loadProjectDetail,
  mapCouncilModel,
  matchWorktree,
  migrateLegacyGlobalConfig,
  NoveltyLifecycleRegistry,
  observeRoundCommits,
  ProjectContextReader,
  type ProjectPrSource,
  ProjectSnapshotGenerator,
  PublishCompositionStore,
  PublishReceiptStore,
  parseGitHubPrRef,
  prWorktreePath,
  RepoWatcher,
  RoundOperationConflictError,
  RoundOperationStore,
  RoundRecordStore,
  readOpenSpecChange,
  readSetupLogTail,
  readSetupStatus,
  readTreeLineCounts,
  recordedVisibility,
  refreshGitHubCredential,
  repoKeyOf,
  repositoryIdentity,
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
  snapshotStoreFor,
  TranscriptStore,
  type TurnMetric,
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
  type ForgePort,
  type ForgePullRequestRef,
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
  planQuoteThreadReanchors,
  prPaperContextFile,
  ReviewService,
  ROUND_COMMIT_RULE,
  recordSeatSend,
  renderComposedPrompt,
  renderWorkOrder,
  resolveAssignment,
  resolveLocus,
  reviewedDiffCommand,
  runNoiseAngle,
  toDistroPath,
  toWindowsView,
  verifyFlaggedReview,
  workOrderContextFileFrom,
} from "@rennet/core";
import type { PromptContextFile } from "@rennet/prompts";
import type {
  CodingHarnessSelection,
  ComposedHandoffBundle,
  ConventionCatalogue,
  CouncilHarnessId,
  DetectedForge,
  DetectedHarness,
  FlaggedReview,
  ForgeRepoIdentity,
  Generation,
  GitHubAuthStatus,
  GitHubConnectPoll,
  LensBoard,
  LensKind,
  LensLane,
  NoiseReview,
  Patchset,
  Project,
  ProjectProcessEvent,
  ProjectSource,
  Review,
  RoundEvent,
  RoundOperation,
  RoundReportHandoff,
  RoundRunReceipt,
  SessionModel,
  SessionPreparation,
} from "@rennet/protocol";
import {
  canonicalize,
  currentGenerationId,
  forgeRepositorySlug,
  LENS_KINDS,
  roundOperationProgressSnapshot,
  serializeDossier,
  sha256Hex,
} from "@rennet/protocol";
import { createBenchmarkRecording } from "./benchmark-store";
import { type BoardsRuntime, createBoardsRuntime } from "./boards/boards-runtime";
import { comparablePath, decideBoundWorkspace, repinBoundWorkspace } from "./bound-workspace";
import { attachCiSignal } from "./ci-signal";
import {
  configureSessionContext,
  createSessionContextPurger,
  sessionContextRelativeDir,
  sweepOrphanedSessionContext,
  writeRunScopedContext,
  writeSessionContext,
} from "./context-files";
import { daemonFilePath } from "./daemon-file";
import { createLiveDeltaDigestPort } from "./delta-digest-live";
import { createDispatch, type DispatchDeps, type FlaggedReviewRun } from "./dispatch";
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
import {
  type ForgePrSubmissionResolver,
  resolveForgePullRequestDestination,
  submitForgePullRequest,
} from "./forge-submission";
import { composeGitHubTransport } from "./github-fetch";
import { createGitHubTokenStore } from "./github-token-store";
import { createLiveComposeBundle } from "./handoff-compose-live";
import { InFlightReviews } from "./in-flight-reviews";
import { sweepLegacyWorktrees } from "./legacy-worktrees";
import { liveProbe, liveProbeMap } from "./live-detection";
import { createDesktopReviewBackend, createDesktopReviewContextFeed } from "./live-review-backend";
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
import {
  createForgeRegistry,
  fetchForgeCiStatus,
  openProjectPullRequest,
  type ProjectPullRequestOpener,
  resolveProjectRepositoryRoot,
} from "./project-forge-registry";
import {
  createProjectProcessJournal,
  type ProjectProcessJournalRecord,
} from "./project-process-journal";
import { createCachedProjectionContext } from "./projection";
import { PushTokenStore } from "./push-token-store";
import { createLiveRefinePort } from "./refine-comment-live";
import { type ReviewContextFeed, runWithReviewContextFeed } from "./review-context-feed";
import type { ReviewIntelligenceSession } from "./review-intelligence-session";
import { createLiveReviewOpenerPort } from "./review-opener-live";
import {
  projectLensBoard,
  projectRoundReportBoard,
  readRoundReportBoardForRecord,
} from "./runtime/lens-board-read";
import { createNodePromptReader } from "./runtime/lens-pipeline";
import { createProjectScoutRuntime, scoutQuestionnaire } from "./runtime/project-scout";
import {
  type BoardRegenerationDeps,
  generationBoardMeta,
  readPriorGeneration,
  runBoardRegeneration,
} from "./runtime/round-collation";
import {
  createRoundExecutionCoordinator,
  type RoundExecutionPorts,
  roundRetryMode,
} from "./runtime/round-execution";
import { RoundProgressHub, roundEventsForDurableOperation } from "./runtime/round-progress";
import {
  createRoundsRuntime,
  type DispatchRoundResult,
  GenerationSupersededError,
  type PersistedBoardMeta,
  type RoundsRuntimeDeps,
  type T3SeatRuntime,
} from "./runtime/rounds";
import { verifyStoredRoundReport } from "./runtime/stored-round-report-verification";
import { resolveCaptureRoot } from "./session/capture-root";
import { roundNumberForDispatch } from "./session/round-number";
import { roundDispatchTranscriptRow, roundReturnTranscriptRow } from "./session/round-transcript";
import {
  enterRoundSession,
  projectIdForRepoRoot,
  resolveRoundSessionId,
  SessionEntry,
} from "./session/session-entry";
import { createSettingsComposition } from "./settings";
import { findHealthyDaemon } from "./supervise";
import { createLiveSymbolLookup, reviewPinnedToHead } from "./symbol-lookup-live";
import { modelSelection } from "./t3/client";
import {
  readHandoffTurnCheckpoint,
  runHandoffTurn as runHandoffTurnOnThread,
  type T3HandoffTurnOutcome,
  type T3TurnCheckpointRead,
} from "./t3/handoff";
import { type SeatThreadWatch, watchSeatThread } from "./t3/seat-progress";
import { createT3SidecarSupervisor } from "./t3/supervisor";
import { type SeatKind, seatThreadTitle, sweepIfArchived } from "./t3/threads";
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

/** The review handoff's turn: one turn on the review's bound T3 thread. `reviewId` is
 *  REQUIRED — the thread is keyed on (repoRoot, reviewId), and there is no other engine
 *  to fall back to (t3-lens-threads 4.3). */
export interface HandoffTurnInput {
  readonly repoRoot: string;
  readonly prompt: string;
  readonly reviewId: string;
}

/** The ROUND WORKER's turn is the handoff turn: one turn on the review's bound T3 thread,
 *  in the session's bound root (session-bound-workspace D2). It carries the sidecar
 *  checkpoint back, because that checkpoint is the round's receipt. */
export type RoundWorkerTurnOutcome = T3HandoffTurnOutcome;
export type RoundWorkerTurnCheckpoint = T3TurnCheckpointRead;

export type CodingHarnessResolution =
  | {
      readonly status: "ready";
      readonly selection: CodingHarnessSelection;
      readonly port: HarnessPort;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Resolve the coding harness for an own-branch turn. A session selection is sticky: once a
 * round records Claude or Codex, later rounds resolve that exact provider and fail plainly if
 * it was disabled or disappeared. A new session chooses from the enabled live ports in stable
 * order and records the result before execution, so choosing Codex is never a hidden fallback.
 */
export async function resolveCodingHarness(input: {
  readonly pinned?: CodingHarnessSelection;
  readonly disabledHarnesses?: readonly string[];
  readonly resolveClaude: () => Promise<HarnessPort | null>;
  readonly resolveCodex: () => Promise<HarnessPort | null>;
}): Promise<CodingHarnessResolution> {
  const disabled = new Set(input.disabledHarnesses ?? []);
  const isDisabled = (id: CodingHarnessSelection["id"]): boolean =>
    disabled.has(id === "claude-code" ? "claude" : "codex") || disabled.has(id);
  const displayName = (id: CodingHarnessSelection["id"]): string =>
    id === "claude-code" ? "Claude Code" : "Codex";
  const tryResolve = async (
    id: CodingHarnessSelection["id"],
  ): Promise<{ readonly port: HarnessPort | null; readonly error?: string }> => {
    try {
      return {
        port: await (id === "claude-code" ? input.resolveClaude() : input.resolveCodex()),
      };
    } catch (error) {
      return {
        port: null,
        error: `${displayName(id)} discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  /** A resolver answering with a DIFFERENT provider than asked — the silent-substitution
   *  shape #681 forbids. One sentence, so the pinned and unpinned paths account for it
   *  identically instead of the unpinned path swallowing what the resolver returned. */
  const misresolution = (
    id: CodingHarnessSelection["id"],
    port: HarnessPort | null,
  ): string | undefined =>
    port !== null && port.descriptor.id !== id
      ? `The ${id} resolver returned ${port.descriptor.id}; refusing to run a different harness than the selected one.`
      : undefined;
  const resolveExact = async (
    id: CodingHarnessSelection["id"],
  ): Promise<CodingHarnessResolution> => {
    if (isDisabled(id)) {
      return {
        status: "unavailable",
        reason: `${displayName(id)} is selected for this session but disabled on its execution host.`,
      };
    }
    const attempt = await tryResolve(id);
    const port = attempt.port;
    if (port === null) {
      return {
        status: "unavailable",
        reason:
          attempt.error ??
          `${displayName(id)} is selected for this session but is not available on its execution host.`,
      };
    }
    const mismatch = misresolution(id, port);
    if (mismatch !== undefined) return { status: "unavailable", reason: mismatch };
    return {
      status: "ready",
      selection: { id, version: port.descriptor.version },
      port,
    };
  };

  if (input.pinned !== undefined) return resolveExact(input.pinned.id);

  const [claudeAttempt, codexAttempt] = await Promise.all([
    isDisabled("claude-code") ? { port: null } : tryResolve("claude-code"),
    isDisabled("codex") ? { port: null } : tryResolve("codex"),
  ]);
  const claude = claudeAttempt.port;
  const codex = codexAttempt.port;
  if (claude !== null && claude.descriptor.id === "claude-code") {
    return {
      status: "ready",
      selection: { id: "claude-code", version: claude.descriptor.version },
      port: claude,
    };
  }
  if (codex !== null && codex.descriptor.id === "codex") {
    return {
      status: "ready",
      selection: { id: "codex", version: codex.descriptor.version },
      port: codex,
    };
  }
  // Nothing usable resolved. Report what actually happened rather than a bare "none
  // available": a resolver that THREW keeps its discovery error, and a resolver that
  // handed back the wrong provider keeps its misresolution sentence. Dropping the
  // latter is how an unpinned Codex-only host that misresolved once read as "no harness
  // installed" — a wrong diagnosis pointing the user at an install they already have.
  return {
    status: "unavailable",
    reason:
      [
        "error" in claudeAttempt ? claudeAttempt.error : undefined,
        misresolution("claude-code", claude),
        "error" in codexAttempt ? codexAttempt.error : undefined,
        misresolution("codex", codex),
      ]
        .filter((reason) => reason !== undefined)
        .join("; ") ||
      "No enabled coding harness (Claude Code or Codex) is available on the execution host.",
  };
}

/**
 * Resolve, durably pin, run, and stamp one coding-harness turn. Keeping this bridge together
 * makes the provider choice part of the session contract rather than an incidental adapter
 * lookup: the pin lands before any mutation, and the exact live version rides the outcome.
 */
export async function runResolvedCodingHarnessTurn(input: {
  readonly sessionId?: string;
  readonly sessionStore: Pick<SessionStore, "load" | "setCodingHarness">;
  readonly disabledHarnesses?: readonly string[];
  readonly resolveClaude: () => Promise<HarnessPort | null>;
  readonly resolveCodex: () => Promise<HarnessPort | null>;
  readonly run: (
    port: HarnessPort,
    persistedSessionId: string | undefined,
  ) => Promise<HandoffTurnOutcome>;
}): Promise<HandoffTurnOutcome> {
  const storedSession =
    input.sessionId === undefined ? undefined : input.sessionStore.load(input.sessionId);
  const resolution = await resolveCodingHarness({
    ...(storedSession?.codingHarness === undefined ? {} : { pinned: storedSession.codingHarness }),
    disabledHarnesses: input.disabledHarnesses ?? [],
    resolveClaude: input.resolveClaude,
    resolveCodex: input.resolveCodex,
  });
  if (resolution.status === "unavailable") {
    return {
      status: "failed",
      reason: resolution.reason,
      turnDiff: "",
      filesTouched: [],
    };
  }
  const persistedSessionId =
    input.sessionId !== undefined && storedSession !== undefined ? input.sessionId : undefined;
  if (persistedSessionId !== undefined) {
    input.sessionStore.setCodingHarness(persistedSessionId, resolution.selection);
  }
  const outcome = await input.run(resolution.port, persistedSessionId);
  return { ...outcome, harness: resolution.selection };
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

export async function captureLandedBranchPatchset(input: {
  readonly git: GitExec;
  readonly locus: Locus;
  readonly repoPath: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headOid: string;
  readonly baseOid: string;
  readonly resolveProjectSnapshotId: (repositoryRoot: string, baseOid: string) => Promise<string>;
}): Promise<Patchset> {
  const gitRoot = (await input.git(input.repoPath, ["rev-parse", "--show-toplevel"])).trim();
  const root = input.locus.kind === "wsl" ? toWindowsView(gitRoot, input.locus.distro) : gitRoot;
  const headOid = (
    await input.git(root, ["rev-parse", "--verify", `${input.headOid}^{commit}`])
  ).trim();
  const baseOid = (
    await input.git(root, ["rev-parse", "--verify", `${input.baseOid}^{commit}`])
  ).trim();
  return captureRangePatchset(input.git, {
    root,
    locus: input.locus,
    baseOid,
    headOid,
    baseRef: input.baseRef,
    headRef: input.headRef,
    source: "local-branch",
    projectSnapshotId: await input.resolveProjectSnapshotId(root, baseOid),
  });
}

function detectedLocusForRepo(repoRoot: string): Locus {
  return resolveLocus(detectLocus(repoRoot)).value;
}

export interface GitLabPrSubmissionResolverDeps {
  readonly locusForRepo: (repoRoot: string) => Locus;
  readonly detectionDepsForLocus: (
    locus: Locus,
  ) => ForgeDetectionDeps | Promise<ForgeDetectionDeps>;
  readonly run?: GitLabPrSubmissionCommandRunner;
}

export function createGitLabPrSubmissionResolver(
  deps: GitLabPrSubmissionResolverDeps,
): ForgePrSubmissionResolver {
  return async (repoRoot) => {
    const locus = deps.locusForRepo(repoRoot);
    return createGitLabPrSubmissionAdapter({
      detectionDeps: await deps.detectionDepsForLocus(locus),
      locus,
      repositoryRoot: repoRoot,
      ...(deps.run === undefined ? {} : { run: deps.run }),
    });
  };
}

/**
 * The round's WORKSPACE: the root the session bound, and the head that root is on before
 * the turn (session-bound-workspace D1/D2). No worktree is created and none is reserved —
 * a round is a turn in the reviewer's own bound root, so this is reads only.
 *
 * It must be a root the round's SOURCE is actually checked out in, and that is checked
 * rather than assumed. A session's recorded root can still be a drafting checkout detached
 * at the reviewed head (a range review's evidence worktree, until the session binding
 * records one root for everything); a round that committed there would move nothing the
 * reviewer can see, advance the review anyway, and leave the branch exactly where it was.
 * That is the "many roots, one label" failure, and it is silent. So the candidates are
 * tried in order and the first one ON the round's source wins; when none is, the round
 * fails naming what it looked for and where.
 *
 * "On the round's source" is TWO facts, because a branch NAME is not an identity: a
 * workspace maps many repos to one session, two of them can both have `feature/shared`
 * checked out, and the name alone picks whichever the mapping happened to yield. So the
 * root must also be the SAME REPOSITORY as the review — equal `git rev-parse
 * --git-common-dir`, which one repository shares with every linked worktree of it and no
 * other repository can equal.
 *
 * Identity, deliberately, and NOT "still contains the reviewed commit". Amending, rebasing
 * and resetting a branch are things reviewers do on purpose; refusing them would be a gate,
 * and the message would be a lie — after a rebase the reviewed commit is unreachable and no
 * amount of checking out brings it back. The successor patchset is a fresh capture from the
 * head the round starts at either way. So a rewritten branch is RECORDED, not refused.
 */
export function createRoundWorkspacePlanner(input: {
  readonly candidateRoots: (operation: RoundOperation) => readonly string[];
  readonly reviewedHead: (operation: RoundOperation) => string;
  readonly headOf: (root: string) => Promise<string | undefined>;
  readonly branchOf: (root: string) => Promise<string | undefined>;
  /** `git rev-parse --git-common-dir`, resolved — one value per repository, worktrees included. */
  readonly repositoryOf: (root: string) => Promise<string | undefined>;
  /** Whether `commit` is an ancestor of (or equal to) this root's HEAD. */
  readonly containsCommit: (root: string, commit: string) => Promise<boolean>;
  readonly now?: () => number;
}): RoundExecutionPorts["planWorkspace"] {
  return async (operation) => {
    const target = operation.sourceTarget;
    const reviewed = input.reviewedHead(operation);
    const repository = await input.repositoryOf(operation.repoRoot);
    const tried: string[] = [];
    for (const root of input.candidateRoots(operation)) {
      if (tried.includes(root)) continue;
      tried.push(root);
      const head = await input.headOf(root);
      if (head === undefined) continue;
      if (target.kind === "branch" && (await input.branchOf(root)) !== target.branch) continue;
      if (target.kind === "detached" && head !== target.head) continue;
      // The name matched; now the repository has to. Asymmetric on purpose: an UNKNOWN
      // repository on either side is silence, not a contradiction, and excluding on silence
      // refuses every root git could not answer for.
      if (repository !== undefined) {
        const candidate = await input.repositoryOf(root);
        if (candidate !== undefined && candidate !== repository) continue;
      }
      const rewritten = !(await input.containsCommit(root, reviewed));
      return {
        kind: "bound-root",
        root,
        sourceHead: head,
        preparedAt: (input.now ?? Date.now)(),
        ...(rewritten ? { branchRewritten: true as const } : {}),
      };
    }
    const wanted =
      target.kind === "branch" ? `the branch ${target.branch}` : `the commit ${target.head}`;
    throw new Error(
      `This round works on ${wanted}, and none of this session's workspaces for this repository is on it: ${tried.join(", ") || "none"}. Check it out there, then dispatch again.`,
    );
  };
}

/**
 * The round worker: ONE turn on the session's bound handoff thread, in the bound root.
 * The turn's sidecar checkpoint — thread, turn, turn count — is the round's receipt, and
 * `thread.checkpoint.revert` against it is what makes the round revertible.
 */
export function createRoundWorkerPort(input: {
  readonly runHandoffTurn: (turn: HandoffTurnInput) => Promise<RoundWorkerTurnOutcome>;
  readonly now?: () => number;
}): RoundExecutionPorts["runWorker"] {
  return async ({ operation, attempt }) => {
    if (operation.state.phase !== "worker-running") {
      throw new Error("Round worker started outside its durable running phase.");
    }
    const outcome = await input.runHandoffTurn({
      repoRoot: operation.state.workspace.root,
      prompt: operation.workOrderPrompt,
      reviewId: operation.reviewId,
    });
    const evidence = {
      ...attempt,
      completedAt: (input.now ?? Date.now)(),
      diff: outcome.turnDiff,
      changedPaths: [...outcome.filesTouched],
      ...(outcome.harness === undefined ? {} : { harness: outcome.harness }),
      ...(outcome.checkpoint === undefined ? {} : { checkpoint: outcome.checkpoint }),
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

/**
 * Restart recovery, now that the round is a turn on a thread the SIDECAR owns.
 *
 * The daemon can die mid-turn; T3 cannot be asked "did execution <id> finish", so the
 * checkpoint is the only durable evidence. A checkpoint completed at or after this
 * worker attempt started is that turn's, and the round settles from it. Nothing at or
 * after it means the turn left no checkpoint, and the round fails NAMING THE BOUND ROOT,
 * because that is where any partial edits are — in the reviewer's own checkout, where
 * they can see them. Never a stale checkpoint from an earlier round on the same thread:
 * the `startedAt` comparison is a positive contradiction, not a "take the last one".
 */
export function createRoundWorkerRecoveryPort(input: {
  readonly readCheckpoint: (turn: {
    readonly repoRoot: string;
    readonly reviewId: string;
    readonly prompt: string;
    readonly since: number;
  }) => Promise<RoundWorkerTurnCheckpoint | undefined>;
  readonly now?: () => number;
}): NonNullable<RoundExecutionPorts["observeWorker"]> {
  return async ({ operation, attempt }) => {
    if (operation.state.phase !== "worker-running") {
      throw new Error("Round worker recovery started outside its durable running phase.");
    }
    const root = operation.state.workspace.root;
    // A read that FAILS and a turn that left NOTHING are different facts, and the reason
    // says which — but both end the same way, because neither can settle a round. The
    // read error is never swallowed into "no checkpoint": that would report a sidecar we
    // could not reach as a turn that did nothing.
    let found: RoundWorkerTurnCheckpoint | undefined;
    let unreadable: string | undefined;
    try {
      found = await input.readCheckpoint({
        repoRoot: root,
        reviewId: operation.reviewId,
        // The thread is shared with the interactive handoff, so the round's own prompt is
        // what identifies its turn — never "whatever finished most recently".
        prompt: operation.workOrderPrompt,
        since: attempt.startedAt,
      });
    } catch (error) {
      unreadable = error instanceof Error ? error.message : String(error);
    }
    const completedAt = (input.now ?? Date.now)();
    if (found === undefined) {
      const what =
        unreadable === undefined
          ? "the turn left no checkpoint"
          : `its checkpoint could not be read (${unreadable})`;
      return {
        ...attempt,
        completedAt,
        outcome: "failed",
        termination: {
          kind: "error",
          reason: `Rennet restarted while this round's turn was running and ${what}. Any partial edits are in ${root}, on your own branch; look there before retrying the asks.`,
        },
        diff: "",
        changedPaths: [],
      };
    }
    // A checkpoint says the turn ENDED, not that it worked: T3 writes one for a failed
    // turn too (status `"error"`) and for a cancelled one (`"missing"`). Only `"ready"`
    // settles the round; the rest keep their diff — the partial edits are real and on the
    // reviewer's branch — and fail with what T3 said about the turn.
    if (found.status !== "ready") {
      return {
        ...attempt,
        completedAt,
        outcome: "failed",
        termination: {
          kind: "error",
          reason: `Rennet restarted while this round's turn was running, and T3 recorded that turn as ${found.status === "error" ? "failed" : "cancelled or interrupted"}. Whatever it changed is in ${root}, on your own branch.`,
        },
        diff: found.diff,
        changedPaths: [...found.filesTouched],
        checkpoint: found.checkpoint,
      };
    }
    return {
      ...attempt,
      completedAt,
      outcome: "completed",
      diff: found.diff,
      changedPaths: [...found.filesTouched],
      checkpoint: found.checkpoint,
    };
  };
}

/** One drafting attempt per review version. A rejected/false attempt is evicted, so the next
 * compose can retry; concurrent doors join the same work instead of drafting duplicate boards. */
export function createBoardDraftCoordinator(
  draft: (
    review: Review,
    emit?: (event: RoundEvent) => void,
    signal?: AbortSignal,
  ) => Promise<boolean>,
  revisionFor: (review: Review) => string = () => "legacy",
): (review: Review, emit?: (event: RoundEvent) => void, signal?: AbortSignal) => Promise<void> {
  type DraftAttempt = {
    readonly promise: Promise<void>;
    readonly signal?: AbortSignal;
    readonly revision: string;
  };
  const inFlight = new Map<string, DraftAttempt>();
  return (review, emit, signal) => {
    const key = `${review.id}:${review.activePatchsetId}`;
    const revision = revisionFor(review);
    const existing = inFlight.get(key);
    if (existing && !existing.signal?.aborted && existing.revision === revision) {
      return existing.promise;
    }
    const attempt =
      existing === undefined
        ? draft(review, emit, signal)
        : existing.promise.catch(() => undefined).then(() => draft(review, emit, signal));
    const tracked = attempt
      .then((settled) => {
        if (!settled) throw new Error("Review board drafting did not settle.");
      })
      .finally(() => {
        if (inFlight.get(key)?.promise === tracked) inFlight.delete(key);
      });
    inFlight.set(key, {
      promise: tracked,
      revision,
      ...(signal === undefined ? {} : { signal }),
    });
    return tracked;
  };
}

export function createRoundRegenerationProgressQueue(handlers: {
  readonly onDiagnostic: (
    event: Extract<RoundEvent, { readonly type: "report-diagnostic" }>,
  ) => void;
  readonly onReport: (event: Extract<RoundEvent, { readonly type: "report" }>) => Promise<void>;
  readonly onLens: (event: Extract<RoundEvent, { readonly type: "lens" }>) => void;
}): {
  readonly emit: (event: RoundEvent) => Promise<void>;
  readonly settle: () => Promise<void>;
} {
  let failure: { readonly error: unknown } | undefined;
  let tail = Promise.resolve();
  const emit = (event: RoundEvent): Promise<void> => {
    if (event.type === "report-diagnostic") {
      try {
        handlers.onDiagnostic(event);
      } catch {
        // Diagnostic publication is best-effort and cannot poison the durable handoff queue.
      }
      return Promise.resolve();
    }
    const scheduled = tail.then(async () => {
      if (failure !== undefined) return;
      if (event.type === "failed") {
        failure = { error: new Error(event.reason) };
        return;
      }
      if (event.type === "report") {
        await handlers.onReport(event);
        return;
      }
      if (event.type === "lens") handlers.onLens(event);
    });
    tail = scheduled.catch((error) => {
      if (failure === undefined) failure = { error };
    });
    return event.type === "report" ? scheduled : tail;
  };
  return {
    emit,
    settle: async () => {
      await tail;
      if (failure !== undefined) throw failure.error;
    },
  };
}

export function startProjectContextMaintenance(input: {
  readonly projects: readonly Project[];
  readonly loadRun: (project: Project) => ProjectProcessJournalRecord | null;
  readonly resume: (
    project: Project,
    runId: string,
  ) => Promise<{ readonly run: { readonly status: string } }>;
  readonly rehydrate: (project: Project) => Promise<void>;
  readonly onError: (error: unknown) => void;
}): void {
  for (const project of input.projects) {
    const initialRun = input.loadRun(project);
    if (initialRun?.status === "queued" || initialRun?.status === "running") {
      void input
        .resume(project, initialRun.runId)
        .then(async (result) => {
          if (result.run.status === "done") await input.rehydrate(project);
        })
        .catch(input.onError);
    } else if (initialRun === null || initialRun.status === "done") {
      void input.rehydrate(project).catch(input.onError);
    }
  }
}

type CompositionBoardsForReview = NonNullable<DispatchDeps["compositionBoardsForReview"]>;

/** Production composition read: join/retry drafting, then return only the exact settled boards
 * named by the persisted generation. An attempt failure is transient because the coordinator
 * evicts it; the signing clients retry the returned `drafting` state in place. */
export function createCompositionBoardsForReview(input: {
  readonly reviewById: (reviewId: string) => Review | undefined;
  readonly loadGeneration: (generation: string) => Generation | undefined;
  readonly ensureBoardDrafting: (review: Review) => Promise<void>;
  readonly readLensBoard: (
    reviewId: string,
    generation: string,
    lens: LensKind,
  ) => Promise<LensBoard | undefined>;
}): CompositionBoardsForReview {
  return async (reviewId, generation) => {
    const review = input.reviewById(reviewId);
    if (!review) return { status: "unavailable", reason: "The review no longer exists." };
    let storedGeneration = input.loadGeneration(generation);
    if (
      storedGeneration === undefined ||
      storedGeneration.patchsetId !== review.activePatchsetId ||
      storedGeneration.draftingBoardIds !== undefined
    ) {
      try {
        await input.ensureBoardDrafting(review);
      } catch {
        return { status: "drafting" };
      }
      storedGeneration = input.loadGeneration(generation);
    }
    if (
      storedGeneration === undefined ||
      storedGeneration.patchsetId !== review.activePatchsetId ||
      storedGeneration.draftingBoardIds !== undefined
    ) {
      // The addressed compose may have captured generation A immediately before another client
      // advanced the review to B. Drafting B can settle successfully while this invocation still
      // names A; ask the caller to retry so it recomputes the current generation rather than
      // terminally stranding the held-open signing view on the version race.
      return { status: "drafting" };
    }
    const boards: LensBoard[] = [];
    for (const lens of LENS_KINDS) {
      const boardId = storedGeneration.lensBoards[lens];
      if (boardId === undefined) continue;
      const board = await input.readLensBoard(reviewId, generation, lens);
      if (board?.boardId !== boardId) {
        return {
          status: "unavailable",
          reason: `The persisted ${lens} board cannot be read for this review.`,
        };
      }
      boards.push(board);
    }
    return { status: "settled", boards };
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
  /** Live `gh auth token` resolver. Absent means this server has no CLI auth source. */
  readonly githubCliToken?: () => Promise<GitHubCliTokenResult>;
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
   * Shut this daemon's PROCESS down (#820). Present ⇒ the listener serves `POST /shutdown`,
   * which acks with this daemon's identity and then calls this. `runDaemon` supplies the same
   * stop SIGTERM runs; a server composed without a process to stop (every test that builds one
   * in-process) leaves it absent and the route 404s.
   */
  readonly onShutdownRequest?: () => void;
  /**
   * This daemon's own server bundle on the host filesystem — the artifact a WSL daemon UPDATE
   * delivers into the distro (C17 cluster 6, #534). `spawnDaemon` passes the entry it launched,
   * which IS that bundle. Absent ⇒ this process cannot deliver one (a daemon started some other
   * way), so a WSL update reports that plainly instead of shipping the wrong file.
   */
  readonly hostBundlePath?: string;
  /** The vendored T3 Code server bundle for the owned sidecar (t3code-sidecar-chat); absent ⇒ `degraded`. */
  readonly t3BundlePath?: string;
  /**
   * Test-composition seam for a hermetic harness. The production daemon never supplies it.
   * The port is routed BY ITS DESCRIPTOR: a `claude-code` port is the Claude seat and
   * leaves Codex absent; a `codex` port is the Codex adapter and leaves Claude absent.
   * That is what lets a hermetic run present a genuinely single-harness host (#681).
   */
  readonly testHarnessPort?: HarnessPort;
  /** Test-composition seam for the Codex utility executor (the council's Codex seats). */
  readonly testCodexExecutor?: CodexExecutor;
  /**
   * Test-composition seam for the T3 SIDECAR's seat runtime. Board seats have no other
   * backend (session-bound-workspace 5.7), so a hermetic proof of the board pipeline
   * supplies a scripted sidecar here — `loadScriptedT3Seats` — exactly as it supplies a
   * scripted harness port for the utility turns. The production daemon never supplies it.
   */
  readonly testT3Seats?: RoundsRuntimeDeps["resolveT3Seats"];
  /** Hermetic production-mapping seam for the ROUND WORKER's coding turn. Tests use it to
   * prove the composition root carries checkpoint evidence even when HEAD does not move.
   * The REVIEW handoff has no such seam any more: it always runs on the review's T3 thread
   * (t3-lens-threads 4.3), and a test drives that through the sidecar. */
  readonly runHandoffTurn?: (input: HandoffTurnInput) => Promise<RoundWorkerTurnOutcome>;
  /** Hermetic opener-drafting seam for compose/post transport proofs. Production uses the
   * live council-routed drafter; tests can supply authored bytes without launching a harness. */
  readonly draftReviewOpener?: DispatchDeps["draftReviewOpener"];
  /** Test override for round landing. Production composes rooted native landing on POSIX daemons. */
  /** Test observation at the crash commit point, before any PR-draft ripening await. */
  readonly onRoundPlaceholderCommitted?: (input: {
    readonly sessionId: string;
    readonly dispatchId: string;
  }) => void | Promise<void>;
  /** Hermetic seam for destination reads and the named-remote branch push. */
  readonly forgeSubmissionGitForLocus?: (locus: Locus) => GitExec;
  /** Hermetic seam for GitLab CLI discovery and execution through the production resolver. */
  readonly gitLabPrSubmissionEffects?: {
    readonly detectionDepsForLocus: (
      locus: Locus,
    ) => ForgeDetectionDeps | Promise<ForgeDetectionDeps>;
    readonly run: GitLabPrSubmissionCommandRunner;
  };
  /** Hermetic seam for GitLab read, CI, and review-publication commands. */
  readonly gitLabForgeEffects?: {
    readonly detectionDepsForLocus: (
      locus: Locus,
    ) => ForgeDetectionDeps | Promise<ForgeDetectionDeps>;
    readonly run: GitLabForgeCommandRunner;
  };
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
  // The benchmark archive (#731, D8): one recorder, one durable file, sibling to the
  // settings stores. The recording toggle is enforced inside `record`, at the single
  // write seam — every producer keeps its identical code path either way.
  const { store: benchmarkStore, record: recordBenchmark } = createBenchmarkRecording(dataDir);
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

  // The owned T3 Code sidecar (t3code-sidecar-chat): composed here, started on the first
  // `chat.t3Session`, adopted from a previous daemon when it still answers, stopped with the
  // daemon. Its provider binaries are the SAME absolute paths Rennet's discovery resolved,
  // so a GUI-launched daemon with launchd's PATH still gives it a working `claude`/`codex`.
  const t3Sidecar = createT3SidecarSupervisor({
    dataDir,
    env,
    bundlePath: options.t3BundlePath,
    // The sidecar runs on the host, so this is the host's own discovery (the same probe
    // `harness.detect` discloses), not a review's locus-threaded harness.
    resolveBinaries: async () => {
      const [claude, codex] = await Promise.all([
        discoverClaude(defaultDiscoveryDeps(), CLAUDE_TESTED_RANGE).catch(() => null),
        discoverCodex(defaultCodexDiscoveryDeps(), {}).catch(() => null),
      ]);
      return {
        ...(claude?.chosen ? { claude: claude.chosen.path } : {}),
        ...(codex?.chosen ? { codex: codex.chosen.path } : {}),
      };
    },
  });

  /**
   * The sidecar's seat runtime for one generation (t3-lens-threads). Every board seat of
   * that generation becomes one persistent thread on the review's checkout, titled by
   * branch and lens; the daemon holds each running seat's subscription so its lane can
   * carry a live line. When the sidecar cannot be brought up — no vendored bundle, a spawn
   * failure — this answers the REASON, and the board seats fail with it. There is no
   * fallback to the ephemeral legs: T3 is a board seat's only backend (Rai's ruling), and
   * a silent fallback would run the lens without its thread, transcript, live line or
   * same-thread repair while the bench showed nothing wrong (review finding 1).
   */
  const resolveT3SeatRuntime = async (input: {
    /** The REPOSITORY the generation belongs to: the T3 project, and half the binding key. */
    readonly repoRoot: string;
    readonly generationId: string;
    readonly branch: string;
    readonly sessionId: string;
    /**
     * The session's bound workspace (session-bound-workspace): every seat thread's cwd, and
     * the prefix stripped from the tool lines its lane shows. Absent ⇒ the repository root,
     * which is the binding for a branch review on the reviewer's own checkout.
     */
    readonly worktreePath?: string;
  }): Promise<T3SeatRuntime | { readonly unavailable: string }> => {
    const workspace = input.worktreePath ?? input.repoRoot;
    let sidecar: Awaited<ReturnType<typeof t3Sidecar.ensure>>;
    try {
      sidecar = await t3Sidecar.ensure();
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) };
    }
    const environmentId = sidecar.environment.environmentId;
    return {
      environmentId,
      seam: {
        client: () => t3Sidecar.client(),
        threadFor: async ({ seat, provider, model, effort }) => {
          const binding = await t3Sidecar.threadFor({
            repositoryRoot: input.repoRoot,
            // The seat runs in the session's bound workspace, not the repository root: T3
            // resolves the turn's cwd as `worktreePath ?? project.workspaceRoot`, so this is
            // what puts `git diff` in the tree the review actually pinned.
            worktreePath: workspace,
            key: { kind: "seat", generationId: input.generationId, seat: seat as SeatKind },
            title: seatThreadTitle(input.branch, seat as SeatKind),
            // Recorded on the row so archiving the session finds this thread. The seat
            // key is (root, generation, seat); the bound workspace may be a worktree, so
            // nothing else on the row ties it back to the session that made it.
            sessionId: input.sessionId,
            // The council's own routing, in the provider's own vocabulary: T3's Claude
            // catalog uses the full ids `mapCouncilModel` already produces, and its Codex
            // catalog uses the council's model names verbatim. Effort rides the same
            // selection; both providers take the council's own levels.
            modelSelection: modelSelection(
              provider,
              provider === "claudeAgent" ? mapCouncilModel(model) : model,
              { effort },
            ),
          });
          return { threadId: binding.threadId, projectId: binding.projectId };
        },
      },
      watch: (threadId, publish) => {
        let watch: SeatThreadWatch | undefined;
        let stopped = false;
        void t3Sidecar
          .client()
          .then((client) => {
            if (stopped) return;
            // The prefix a seat's tool line is stripped against is the tree it RUNS in.
            watch = watchSeatThread({ client, threadId, repoRoot: workspace, publish });
          })
          .catch(() => undefined);
        return {
          stop: () => {
            stopped = true;
            watch?.stop();
          },
        };
      },
    };
  };

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
    /** The full agentic port for write-enabled coding rounds, or null when unavailable. */
    readonly adapter: HarnessPort | null;
  }
  // Memoized PER LOCUS (add-windows-support / #334), like the Claude harness: the host
  // resolution is shared as before; a WSL-locus project discovers and runs the DISTRO's
  // own `codex` (distro discovery deps, locus-wrapped executor, distro-side scratch).
  // The utility executor carries the locus so every spawn enters the distro through
  // `locusCommand` — a WSL review is dual-harness rather than degrading to
  // single-Claude. The same resolution now owns the agentic adapter used by Codex-backed
  // coding rounds, so discovery, version provenance, and executable choice cannot drift.
  // The sink for every Codex utility turn's measurement. These turns belong to no
  // generation — they are one-off producers behind a command, not round legs — so there is
  // no durable `usage` record to add them to, and the daemon log is where the figure lands.
  // The point is that it lands somewhere: the user's subscription pays for the turn, and a
  // prompt's cost is invisible in a diff. Never throws into a send.
  const codexUtilityMetrics = {
    record(metric: TurnMetric): void {
      const parts = [
        `${metric.label} ${metric.status}`,
        `model=${metric.model ?? "unknown"}`,
        `${metric.latencyMs}ms`,
        metric.usage === null ? "tokens=unreported" : `tokens=${metric.usage.totalTokens}`,
      ];
      if (metric.inlineContextBytes !== undefined) {
        parts.push(`inlineContextBytes=${metric.inlineContextBytes}`);
      }
      console.log(`[codex-utility] ${parts.join(" ")}`);
    },
  };
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
            adapter: null,
          };
        }
        const explicitBin = env.RENNET_CODEX_BIN;
        const discoveryDeps =
          locus.kind === "wsl" ? await wslDiscoveryDeps(locus.distro) : defaultCodexDiscoveryDeps();
        const result = await createCodexHarness({
          discoveryDeps,
          locus,
          // The RENNET_CODEX_BIN override is a host path; it never applies to a distro.
          ...(locus.kind === "host" && explicitBin && explicitBin.length > 0
            ? { explicitBin }
            : {}),
        });
        const chosen = result.discovery.chosen;
        if (!chosen) {
          return {
            availability: { available: false, version: null },
            makeExecutor: null,
            binPath: null,
            version: null,
            adapter: null,
          };
        }
        // Every utility send through this executor records its measurement (#737 tap):
        // the ports call `codex exec` directly, so nothing else on that path sees the
        // tokens or the inlined bytes.
        const makeExecutor = (repoRoot: string): CodexExecutor =>
          instrumentCodexExecutor(
            createCodexExecutor(defaultCodexExecEffects, {
              bin: chosen.path,
              harnessVersion: chosen.version,
              ...(chosen.runtimePath === undefined ? {} : { runtimePath: chosen.runtimePath }),
              ...(locus.kind === "wsl" ? { locus } : {}),
              repoRoot,
            }),
            codexUtilityMetrics,
            "codex-utility",
          );
        return {
          availability: { available: true, version: chosen.version },
          makeExecutor,
          binPath: chosen.path,
          version: chosen.version,
          adapter: result.adapter,
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
    if (options.testHarnessPort !== undefined) {
      return options.testHarnessPort.descriptor.id === "claude-code"
        ? options.testHarnessPort
        : null;
    }
    const { locus, distroCwd } = locusContextForRepo(repoRoot);
    return (await getClaudeHarness(locus, distroCwd)).adapter ?? null;
  }
  /** The utility executor for a repo, ROOTED AT THAT CHECKOUT (W5) — locus-native, so a
   *  WSL project's seat gets the distro path the distro's codex can actually open. */
  async function codexExecutorForRepo(repoRoot: string): Promise<CodexExecutor | null> {
    if (options.testCodexExecutor !== undefined) return options.testCodexExecutor;
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
  // it, so installing `gh` or `glab` — or signing in with either — shows up on the next read
  // instead of after a restart. Feeds `sourceControlByHost`.
  function detectForges(): Promise<DetectedForge[]> {
    return shareForgeDetection(() =>
      runForgeDetection(defaultForgeDetectionDeps()).catch(() => []),
    );
  }

  // Per-host forge detection (C17 amendment B) — the exact mirror of `detectHarnessesOn`, so a
  // WSL card shows the DISTRO's own `gh` and `glab` auth states instead of a Source Control
  // section it is structurally incapable of filling. `local` is the memoized ambient answer;
  // `wsl:<distro>` runs the whole probe chain inside the distro (a distro `wsl.exe` cannot
  // enter reports UNASKED, never "no CLIs"); a paired `remote:` device dials US, so it cannot be
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
  // code here holds a raw socket. Auth resolves lazily on each top-level egress:
  // the live `gh` credential first, then the daemon's 0600 token file as fallback.
  // Construction and dry-runs never ask either source for a credential.
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
      ...(options.githubCliToken === undefined ? {} : { cliToken: options.githubCliToken }),
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

  // Resolve a token-bound Octokit for each real adapter call. In particular, a
  // daemon-lifetime client must not pin the token returned by `gh auth token`:
  // `gh auth switch`, login, and logout take effect on the next operation.
  async function resolveGitHubOctokit() {
    const auth = await resolveGitHubAuthOk();
    return createGitHubOctokit({ fetch: publishHttp, token: auth.token });
  }

  const githubCiStatusSource: Pick<ForgePort, "fetchCiStatus"> = {
    fetchCiStatus: async (ref, headOid, signal) =>
      new GitHubForgeAdapter({ octokit: await resolveGitHubOctokit() }).fetchCiStatus(
        ref,
        headOid,
        signal,
      ),
  };

  const githubReviewPublisher = new GitHubPublishAdapter({ resolveOctokit: resolveGitHubOctokit });

  function gitLabForgeAdapterForRoot(repoRoot: string): GitLabForgeAdapter {
    const locus = locusForRepo(repoRoot);
    const detectionDeps =
      options.gitLabForgeEffects?.detectionDepsForLocus(locus) ??
      (locus.kind === "wsl" ? wslForgeDetectionDeps(locus.distro) : defaultForgeDetectionDeps());
    return new GitLabForgeAdapter({
      detectionDeps,
      locus,
      repositoryRoot: repoRoot,
      ...(options.gitLabForgeEffects === undefined ? {} : { run: options.gitLabForgeEffects.run }),
    });
  }

  const githubPrSubmission = new GitHubPrSubmissionAdapter({
    resolveOctokit: resolveGitHubOctokit,
  });
  // Submission is repository-scoped because a WSL repository must use that distro's
  // proven `glab`, never a similarly named binary from the Windows host.
  const gitLabPrSubmissionResolver = createGitLabPrSubmissionResolver({
    locusForRepo,
    detectionDepsForLocus:
      options.gitLabPrSubmissionEffects?.detectionDepsForLocus ??
      (async (locus) =>
        locus.kind === "wsl" ? wslForgeDetectionDeps(locus.distro) : defaultForgeDetectionDeps()),
    ...(options.gitLabPrSubmissionEffects === undefined
      ? {}
      : { run: options.gitLabPrSubmissionEffects.run }),
  });
  const forgePrSubmissionResolvers = createForgeRegistry<ForgePrSubmissionResolver>([
    { forge: "github", implementation: () => githubPrSubmission },
    { forge: "gitlab", implementation: gitLabPrSubmissionResolver },
  ]);

  // CI is independently capability-routed so submission never implies a CI read.
  // GitLab stays unregistered until intake (or a durable post-submit association)
  // gives the review an exact MR target; own-branch submission alone does not.
  const forgeCiStatusSources = createForgeRegistry<Pick<ForgePort, "fetchCiStatus">>([
    { forge: "github", implementation: githubCiStatusSource },
  ]);

  // Account mutations (device-flow store, paste, disconnect) are SERIALIZED so a
  // flow completing mid-disconnect cannot interleave with the token file write and
  // resurrect a token the user just forgot.
  let accountLock: Promise<unknown> = Promise.resolve();
  function withAccountLock<T>(mutate: () => Promise<T>): Promise<T> {
    const next = accountLock.then(mutate, mutate);
    accountLock = next.catch(() => undefined);
    return next;
  }

  // The live project-detail PR source (issue #37, B2). Resolved from the SAME auth
  // ladder as egress, once per `project.detail`. When auth is unavailable
  // it stays `null` and `project.detail` degrades to the local-only
  // list (B1) — a missing token is a local-only surface, never a failed fetch rendered
  // as "zero PRs". Resolution is lazy, never at launch, and a distinct
  // auth-unavailable REASON and credential source ride along so the detail screen
  // can say which problem stands between the user and the PR half without offering
  // a fallback action for a `gh` credential the CLI still owns.
  interface ProjectPrResolution {
    source: ProjectPrSource | null;
    credentialSource?: "gh" | "fallback";
    authUnavailable?: "not-connected" | "token-invalid" | "insufficient-scope" | "network";
    authUnavailableCopy?: string;
  }
  async function resolveProjectPrSource(): Promise<ProjectPrResolution> {
    let auth: Awaited<ReturnType<typeof resolveAuth>>;
    try {
      auth = await resolveAuth();
    } catch {
      // `resolveGitHubAuth` classifies transport failures as the honest `network`
      // reason itself, so only a non-network fault lands here (store corruption,
      // a broken response). Degrade to the local-only list rather than failing the
      // whole project.detail RPC; the next call resolves from scratch and retries.
      return { source: null };
    }
    if (!auth.ok) {
      return {
        source: null,
        authUnavailable: auth.reason,
        authUnavailableCopy: auth.copy,
        ...("source" in auth ? { credentialSource: auth.source } : {}),
      };
    }
    return {
      credentialSource: auth.source,
      source: createGitHubProjectPrSource({
        octokit: createGitHubOctokit({ fetch: publishHttp, token: auth.token }),
      }),
    };
  }

  /** The renderer-safe projection of the host auth state (the token never leaves). */
  function projectAuthStatus(auth: Awaited<ReturnType<typeof resolveAuth>>): GitHubAuthStatus {
    if (auth.ok) {
      return { state: "connected", source: auth.source, login: auth.login, scopes: auth.scopes };
    }
    if (auth.reason === "insufficient-scope") {
      return {
        state: "insufficient-scope",
        source: auth.source,
        copy: auth.copy,
        scopes: auth.scopes,
      };
    }
    if (auth.reason === "not-connected") return { state: auth.reason, copy: auth.copy };
    return { state: auth.reason, source: auth.source, copy: auth.copy };
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
        });
      }
      return projectAuthStatus(state);
    },
    async disconnect(): Promise<void> {
      deviceFlow?.controller.abort();
      deviceFlow = null;
      await withAccountLock(async () => {
        await gitHubSecretStore.setGitHubCredential(null);
      });
    },
  };

  // APPEND-ONLY, and load-bearing: `createCachedProjectionContext` uses this set's SIZE as
  // its version, so a root may be added but never removed or swapped in place.
  const allowedRoots = new Set<string>();
  // Proactive Repo Map rehydration (#143/#243): keeps each built project's structural
  // snapshot warm as its reference branch advances.
  // Assigned in `whenReady`, torn down on quit.
  let rehydration: ProactiveRehydration | null = null;
  // The loopback WS listener (#378), assigned once dispatch exists (below). The
  // rehydration broadcast and shutdown reference it through this binding; both run
  // after construction, by which time it is set.
  let wsListener: WsListener | null = null;
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
   * The ONE workspace a session is bound to (session-bound-workspace D1), decided once from
   * the review target and then only re-pinned:
   *
   *   • branch review, and some worktree of the repository already has that branch checked
   *     out (usually the reviewer's own) → THAT checkout, and no worktree is created. Asked
   *     of git rather than assumed, because git refuses `worktree add` for a branch checked
   *     out elsewhere — binding blind would fail on exactly the tree to bind to.
   *   • branch review of a branch nothing has out → a Rennet-created worktree at
   *     `<dataDir>/worktrees/<repoKey>/<branch>`, with the branch CHECKED OUT, because a
   *     round commits on the session's branch here.
   *   • PR snapshot → the detached worktree at the reviewed head, the one already indexed in
   *     `pr-worktrees.json`, re-pinned in place when a round advances that head.
   *
   * A working-tree capture is the degenerate branch case: its evidence IS the live checkout
   * the capture froze, so it binds there.
   *
   * The decision is RECORDED on the session, so it is made once for the session's life and
   * every later read is the recorded field. A session minted before this wave has no
   * recorded root and binds here, lazily, on its first use (D migration step 4). A workspace
   * that could NOT be created records nothing and throws: the clone sits on whatever ref it
   * sits on, so a recorded fallback would run every later turn of the session against a tree
   * the review is not about. The next use retries the bind.
   *
   * Single-flighted per session, because the six seats ask together with the capture: two
   * concurrent decisions would race `git worktree add` against itself, and the loser's
   * failure is exactly the fallback this refuses to record.
   */
  const bindingsInFlight = new Map<string, Promise<string>>();
  function bindWorkspaceFor(review: Review): Promise<string> {
    const sessionId = sessionIdForReview(review);
    const inFlight = bindingsInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const binding = resolveBoundWorkspace(review, sessionId).finally(() =>
      bindingsInFlight.delete(sessionId),
    );
    bindingsInFlight.set(sessionId, binding);
    return binding;
  }

  async function resolveBoundWorkspace(review: Review, sessionId: string): Promise<string> {
    const workspaceDeps = {
      gitFor: gitForRepo,
      locusOf: locusForRepo,
      repoKeyForRoot,
      dataDir,
      prWorktreeFor: (reviewId: string) => readPrWorktreeIndex()[reviewId]?.path,
      recordPrWorktree,
      // Fire and forget, exactly as the pull-request front door runs it: a slow install
      // must never delay the capture, and a failed one is honest status rather than a wall.
      onWorktreeCreated: (worktree: string) =>
        void runPrWorktreeSetup(worktree).catch(() => undefined),
    };
    const recorded = sessionStore.load(sessionId)?.boundRoot;
    // A recorded binding is RE-PINNED, never re-decided: a landed round advances the reviewed
    // head, and a pull-request snapshot's workspace is a detached checkout at the old one.
    if (recorded !== undefined) return repinBoundWorkspace(review, recorded, workspaceDeps);
    const root = await decideBoundWorkspace(review, workspaceDeps);
    sessionStore.setBoundRoot(sessionId, root);
    return root;
  }

  /**
   * The seam the round path reaches the bound workspace through — the name and signature the
   * round collation already binds. It is a read of the session's binding plus the re-pin a
   * moved head needs; it never re-decides which workspace the session took.
   */
  const draftingRootFor = (review: Review): Promise<string> => bindWorkspaceFor(review);

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
  async function openPullRequestRef(
    commandId: string,
    prRef: ForgePullRequestRef,
    repoPath: string | undefined,
    retrospective: boolean,
    forge: ForgePort,
  ): Promise<Review> {
    const root = await resolvePrRepoRoot(prRef, repoPath);
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
      remoteHeadRef: (ref) =>
        ref.repo.forge === "gitlab"
          ? `refs/merge-requests/${ref.number}/head`
          : `refs/pull/${ref.number}/head`,
      resolveProjectSnapshotId: (repoRoot, baseOid) =>
        ensureProjectSnapshotPin(liveSnapshotStore, repoRoot, baseOid, gitInLocus),
    });
    const result = await source.open(prRef);
    if (!result.pin) {
      // Defensive: the root was resolved by identity above, so a null pin should be
      // unreachable — but never continue into a lying degraded state silently.
      throw new Error(
        `Could not open ${prRef.repo.owner}/${prRef.repo.name} change request ${prRef.number} from a local clone.`,
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
    return openPullRequestRef(
      commandId,
      prRef,
      repoPath,
      retrospective,
      new GitHubForgeAdapter({ octokit: await resolveGitHubOctokit() }),
    );
  }

  const projectPullRequestOpeners = createForgeRegistry<ProjectPullRequestOpener<Review>>([
    {
      forge: "github",
      implementation: ({ commandId, repository, number, repoPath, retrospective }) =>
        resolveGitHubOctokit().then((octokit) =>
          openPullRequestRef(
            commandId,
            { repo: repository, number },
            repoPath,
            retrospective,
            new GitHubForgeAdapter({ octokit }),
          ),
        ),
    },
    {
      forge: "gitlab",
      implementation: async ({ commandId, repository, number, repoPath, retrospective }) => {
        const root = await resolvePrRepoRoot({ repo: repository, number }, repoPath);
        return openPullRequestRef(
          commandId,
          { repo: repository, number },
          root,
          retrospective,
          gitLabForgeAdapterForRoot(root),
        );
      },
    },
  ]);

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
    // The session's bound workspace, not the repository: on a WSL locus the distro cwd is
    // BAKED into the adapter's `wsl.exe --cd` argv and `transportCwd` wins over the spec's
    // `cwd`, so a harness resolved from the repository root ignores the turn's cwd entirely
    // and every seat drafts in the wrong tree (task 5.2, PR #789).
    const turnRoot = turnRootFor(review);
    const { locus, distroCwd } = locusContextForRepo(turnRoot);
    const adapter = await claudeAdapterForRepo(turnRoot);
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
    // The Codex leg roots at the session's bound workspace, like the Claude leg right below
    // it — the same root its context files were written under.
    const codexUtilityExecutor = codexResolution.makeExecutor?.(distroCwd ?? turnRoot);
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
                cwd: turnRoot,
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
      const runTurn = createVerificationTurn(adapter, { cwd: turnRoot });
      // BUDGET-GATE (Rule 75, vital money circuit): `maxVerifications` caps how many
      // findings are verified — the over-cap remainder surfaces an honest "not verified"
      // caveat chip (CAP_CAVEAT), NEVER a silent skip that would read as an all-clear —
      // and the invocation budget bounds actual model turns (one per finding,
      // with a visible refusal floor). Both limits surface on the findings themselves; the returned
      // telemetry is the aggregate of those same per-finding chips, so no capped or
      // refused finding is dropped without a visible caveat.
      const { review: verified } = await verifyFlaggedReview(flagged, {
        readFileWindow,
        writeContext: (files) => writeReviewContext(review, files),
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
      fetchCiStatus: (ref, headOid, signal) =>
        ref.repo.forge === "gitlab"
          ? gitLabForgeAdapterForRoot(review.repositoryRoot).fetchCiStatus(ref, headOid, signal)
          : fetchForgeCiStatus(forgeCiStatusSources, ref, headOid, signal),
      ...(ciRefinementTurn === undefined
        ? {}
        : {
            refineTurn: ciRefinementTurn,
            writeContext: (files: readonly PromptContextFile[]) =>
              writeReviewContext(review, files),
          }),
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
    // Resolved from the BOUND workspace: a WSL adapter bakes its distro cwd at construction,
    // so resolving from the repository root would ignore the `cwd` the turn asks for below.
    const turnRoot = turnRootFor(review);
    const adapter = await claudeAdapterForRepo(turnRoot);
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
      cwd: turnRoot,
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
      // session-context-files: the offer AND the assembled project context are written
      // under the seat's cwd and NAMED there. Nothing about the change rides inline, and
      // no prompt names the daemon's own store path, which a seat in another locus
      // (a WSL distro) cannot open.
      writeContext: (files) => writeReviewContext(review, files),
      diffCommand: reviewedDiffCommand(patchset.repository),
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
  // snapshot warm as its reference branch advances. The background pass
  // narrates on the SAME progress push the processing screen uses (now WS `progressEvent`
  // frames fanned to every client, #378), under a stable command id, so the mechanism is
  // visible-capable with no new protocol surface. It only warms repos that already have a
  // snapshot — it never cold-builds in the background.
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
  // The project-scout scheduler (#461 §4, B7 cluster 4): shares the processing
  // progress push; the deterministic pass runs even with no harness installed.
  const projectScoutRuntime = createProjectScoutRuntime({
    store: snapshotStore,
    gitForRepo,
    resolveClaudePort: claudeAdapterForRepo,
    resolveCodexExecutor: codexExecutorForRepo,
    narrate: narrateBackground,
  });
  const projectProcessJournal = createProjectProcessJournal(snapshotStore);
  rehydration = createProactiveRehydration({
    store: snapshotStore,
    generator: snapshotGenerator,
    narrate: narrateBackground,
    // A background pass that throws is otherwise swallowed whole: with no
    // `onError` the rehydration registry and the watcher start had nowhere to
    // put a failure.
    onError: (error) => console.error("Proactive rehydration failed", error),
    runNoveltyPass: (repoKey) => liveNoveltyLifecycle.advanceRepo(repoKey),
  });
  // One durable add-project run owns scout → structural map. Its journal lives
  // beside the map so a daemon restart replays completed steps and resumes the
  // first incomplete phase under the same stable command identity.
  const processProjectCore = createProcessProject({
    generate: (repoRoot, options) => snapshotGenerator.generate(repoRoot, options),
    listProjects: () => projectStore.list(),
    repoKeyForRoot,
    journal: projectProcessJournal,
    // The Repo Map build's per-stage archive (#731 9.2). The stages come from the
    // generator's own progress stream, so nothing new is measured here.
    recordBenchmark,
    runScout: async (input) => {
      const result = await projectScoutRuntime.runForRepo({
        projectId: input.projectId,
        repoKey: input.repoKey,
        repoRoot: input.repoRoot,
        defaultBranch: input.defaultBranch,
        runId: input.runId,
        narrate: input.narrate,
      });
      return result ? scoutQuestionnaire(basename(input.repoRoot), result) : null;
    },
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
  const publishCompositionStore = new PublishCompositionStore(
    join(dataDir, "publish-compositions"),
  );
  const publishReceiptStore = new PublishReceiptStore(join(dataDir, "publish-receipts"));
  // The own-branch PR destination is resolved once for the preview and again immediately
  // before sign-click mutation. Both reads execute inside the repository's locus and use the
  // effective push URL; no forge credential is touched while composing the preview.
  const resolvePullRequestDestination: NonNullable<
    DispatchDeps["resolvePullRequestDestination"]
  > = (repoRoot) => {
    const locus = locusForRepo(repoRoot);
    const gitInLocus = options.forgeSubmissionGitForLocus?.(locus) ?? execaGitFor(locus);
    return resolveForgePullRequestDestination({
      registry: forgePrSubmissionResolvers,
      git: gitInLocus,
      repoRoot,
    });
  };
  // The sign-click consumes the exact destination object resolved immediately beforehand.
  // Pushing your own branch is not publishing (AGENTS.md); the provider create remains the
  // only external publication and resolves credentials lazily inside that operation.
  const submitPullRequest: NonNullable<DispatchDeps["submitPullRequest"]> = (input) => {
    const locus = locusForRepo(input.repoRoot);
    const gitInLocus = options.forgeSubmissionGitForLocus?.(locus) ?? execaGitFor(locus);
    return submitForgePullRequest({
      registry: forgePrSubmissionResolvers,
      git: gitInLocus,
      ...input,
    });
  };
  // B11: the durable ask-log store (~/.rennet/asks), sibling to the thread store.
  // Backs the `ask.*` write path (the sole writers) and the reload-survival read
  // a reconnecting client rehydrates from (`ask.read`).
  const askLogStore = new AskLogStore(join(dataDir, "asks"));
  // The durable session store (B09) — the cursor the turn loop resumes from and the rows
  // the sidebar lists both live here.
  const sessionStore = new SessionStore(join(dataDir, "sessions"));
  for (const session of sessionStore.list()) {
    const preparation = session.preparation;
    if (preparation?.status !== "capturing" && preparation?.status !== "drafting") continue;
    const interruptedAfterCapture =
      preparation.status === "drafting" || session.reviewId !== undefined;
    sessionStore.setPreparation(session.id, {
      status: "failed",
      stage: interruptedAfterCapture ? "boards" : "capture",
      reason: "Rennet restarted before preparation finished. Retry to continue.",
      ...(session.reviewId === undefined ? {} : { reviewId: session.reviewId }),
      ...(preparation.status === "drafting" ? { lanes: preparation.lanes } : {}),
    });
  }
  // Name this daemon on every context directory it writes, and read each repo's own
  // visibility before ensuring the ignore block — the two facts the writer cannot know
  // from a call (session-context-files, review findings 1 and 2).
  configureSessionContext({
    owner: dataDir,
    visibilityOf: (repoRoot) => recordedVisibility(liveSnapshotStore, repoRoot),
  });
  /**
   * The workspace a session is bound to (session-bound-workspace D1) — the cwd of every turn
   * it spawns, and the root its `.rennet/context/<id>` directory lives under.
   *
   * A read of the recorded field. The fallbacks are for a session minted before the binding
   * wave and not yet used: its OWN `repositoryRoot` — a workspace project maps many repos to
   * one id and that mapping is not invertible, so `projectId` can never answer "which repo" —
   * then the attached review's root. Such a session binds for real, and records it, on its
   * first use through `bindWorkspaceFor`.
   */
  const boundRootForSession = (sessionId: string): string | undefined => {
    const session = sessionStore.load(sessionId);
    if (session === undefined) return undefined;
    if (session.boundRoot !== undefined) return session.boundRoot;
    if (session.repositoryRoot !== undefined) return session.repositoryRoot;
    return session.reviewId === undefined
      ? undefined
      : service.reviewById(session.reviewId)?.repositoryRoot;
  };
  // Deferred while a round is in flight: `session.archive` awaits the session's
  // preparation, but nothing tracks a round, so an immediate purge deletes the directory
  // the round's next turn reads. The round's settle path purges instead.
  /**
   * The roots a ROUND wrote its work order into, per session. A round runs in the root
   * that actually holds its branch, which is not always the root `boundRootForSession`
   * reports — so without this the archive purge removes the recorded root's directory and
   * silently leaves the round's `work-order.md` in the reviewer's checkout. Process-local
   * on purpose: it covers an archive landing while the daemon is up, and the daemon-start
   * orphan sweep covers what a crash leaves.
   */
  const roundWorkspaceRoots = new Map<string, string>();
  const contextPurger = createSessionContextPurger((sessionId) => {
    const bound = boundRootForSession(sessionId);
    const round = roundWorkspaceRoots.get(sessionId);
    return [bound, round].filter((root): root is string => root !== undefined);
  });
  const purgeContextForSession = (sessionId: string): void => void contextPurger.purge(sessionId);
  /**
   * Every workspace a context directory could be UNDER, for the context sweep: every recorded
   * bound root — archived sessions included, since theirs is exactly what that sweep collects —
   * plus every worktree the pull-request index has ever named. A directory written in a
   * worktree is invisible to a sweep that looks only at project roots (review finding 8).
   *
   * Deliberately a superset: the context sweep decides what to delete from the `.owner` stamp
   * and the session id, so a root it looks in but owns nothing under costs one `readdir`.
   */
  const contextSweepRoots = (): string[] => [
    ...sessionStore
      .list()
      .flatMap((session) => (session.boundRoot === undefined ? [] : [session.boundRoot])),
    ...Object.values(readPrWorktreeIndex()).map((entry) => entry.path),
  ];
  /**
   * The workspaces a LIVE session is bound to, for the legacy-worktree sweep — which DELETES,
   * so this has to be exact, not a superset.
   *
   * The pull-request worktree index only ever grows, and the version before this wave recorded
   * every range review's `worktrees/review/<id>` in it; unioning the whole index would spare
   * every legacy review worktree forever and make that half of the sweep a no-op. So: only
   * sessions the store still holds and has not archived, and for those the index entry their
   * own review holds, which is where a pre-wave session's workspace still is.
   */
  const liveBoundRoots = (): string[] => {
    const index = readPrWorktreeIndex();
    return sessionStore
      .list()
      .filter((session) => session.archivedAt === undefined)
      .flatMap((session) => [
        ...(session.boundRoot === undefined ? [] : [session.boundRoot]),
        ...(session.reviewId === undefined ? [] : [index[session.reviewId]?.path ?? []].flat()),
      ]);
  };
  // The daemon-start orphan sweep (session-context-files): a crash between a context write
  // and an archive leaves a directory nobody would ever purge, so the next start collects
  // every one THIS daemon wrote whose session the store no longer holds or already marks
  // archived, and says how many in the log.
  // Every root the daemon knows is looked in — `openPath` is only "the repo, or the FIRST
  // included repo", so a workspace's other repos are swept from `includedRepoPaths`, and the
  // recorded bound roots cover a session whose files went into a worktree instead.
  sweepOrphanedSessionContext(
    [
      ...projectStore
        .list()
        .flatMap((project) => [project.openPath, ...(project.includedRepoPaths ?? [])]),
      ...contextSweepRoots(),
    ],
    {
      // RAW ids: a record that will not parse is skipped by `list()`, and treating that
      // silence as "the session is gone" deletes a live session's files.
      persistedIds: new Set(sessionStore.persistedIds()),
      archivedIds: new Set(
        sessionStore
          .list()
          .filter((session) => session.archivedAt !== undefined)
          .map((session) => session.id),
      ),
    },
  );
  // The worktree zoo's last rites (session-bound-workspace 5.5): one session now binds to one
  // workspace, so the per-round and per-review worktrees earlier versions left under the data
  // dir are removed here, once, and nothing recreates them. Fire and forget — a sweep must
  // never delay or fail a daemon start — and only directories no live session's `boundRoot`
  // names are touched.
  void sweepLegacyWorktrees({
    dataDir,
    liveBoundRoots,
    gitFor: gitForRepo,
  }).catch(() => undefined);
  const sessionPreparations = new Map<string, AbortController>();
  const sessionPreparationRuns = new Map<string, Promise<void>>();
  // The display-transcript store (issue-set B): the durable read-model behind
  // `session.transcript`. Coding turns and round lifecycle receipts append here.
  const transcriptStore = new TranscriptStore(join(dataDir, "transcripts"));
  const appendRoundTranscript = (
    sessionId: string,
    rows: readonly ReturnType<typeof roundDispatchTranscriptRow>[],
  ): void => {
    transcriptStore.appendUnique(sessionId, rows);
  };
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
  // ONE loop per repo root + selected harness, and the repo root is the SINGLE source of the
  // turn's cwd: the loop key IS what `buildSpec` returns, so there is no second copy of that
  // fact to drift. The harness is part of the key because two sessions over one repository may
  // have pinned different providers; returning a cached Claude loop for a Codex session would
  // silently execute the wrong provider.
  // The handoff exit (t3-lens-threads 4.3): a composed work order runs as ONE turn on the
  // review's bound T3 thread. One engine, no switch — the review is what names the thread,
  // and the thread is keyed on the review's REPOSITORY ROOT, never a project id.
  const runHandoffTurn = async (input: HandoffTurnInput): Promise<RoundWorkerTurnOutcome> => {
    // The work order runs in the session's bound workspace, the same tree its seats read and
    // the same one the round's turn takes — the binding is half the thread's key, so this is
    // also what keeps chat, handoff and round on ONE thread. Bound here if nothing has.
    const bound = await boundWorkspaceForReview(input.reviewId);
    return runHandoffTurnOnThread(
      bound === undefined
        ? input
        : {
            ...input,
            worktreePath: bound.root,
            ...(bound.branch === undefined ? {} : { branch: bound.branch }),
          },
      t3Sidecar,
    );
  };
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
  const readPrompt = createNodePromptReader(promptsSrcDir);
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
  /**
   * The workspace the session owning this review is bound to (session-bound-workspace), for
   * the two surfaces that name a review rather than a session: the review's own T3 thread
   * (chat and handoff) and the chat header's trail.
   *
   * `branch` is present exactly when the bound workspace has one CHECKED OUT — a branch
   * review binds to a checkout of the reviewed branch, a PR snapshot binds to a detached
   * worktree at the reviewed head and has none. It is what lets the sidecar rebuild a thread's
   * worktree if it disappears; naming a branch a detached workspace does not have would make
   * it rebuild the wrong tree.
   */
  /**
   * The root a review's turns run in and its context files live under: the session's binding
   * (session-bound-workspace), falling back to the repository root for a session that has not
   * bound one yet. This is the cwd every cold utility turn takes — a seat and a scout that
   * disagree about which tree they are in read different bytes for the same review.
   */
  const turnRootFor = (review: Review): string =>
    boundRootForSession(sessionIdForReview(review)) ?? review.repositoryRoot;

  async function boundWorkspaceForReview(
    reviewId: string,
  ): Promise<{ readonly root: string; readonly branch?: string } | undefined> {
    const review = service.reviewById(reviewId);
    if (!review) return undefined;
    // Binds if nothing has yet, rather than reading the clone through `turnRootFor`'s
    // fallback: this is the read the CHAT and the HANDOFF thread are created from, and a
    // thread's cwd is fixed at creation. Getting the clone here is not a degraded answer, it
    // is a second thread for the same session rooted in the wrong tree.
    const root = await bindWorkspaceFor(review);
    const branch =
      review.postTarget === undefined && review.retrospective !== true
        ? review.patchsets.find((entry) => entry.id === review.activePatchsetId)?.repository.headRef
        : undefined;
    return { root, ...(branch === undefined ? {} : { branch }) };
  }
  /**
   * The context-file seam every review-scoped utility turn writes through
   * (session-context-files, D3/D4): the ONE writer, keyed on the SAME session id the
   * rounds ledger and the archive purge use, so a turn's scratch is purged with the
   * session that spent it. `review.repositoryRoot` — never the project's open path, which
   * is only "the repo, or the first included repo" of a workspace.
   *
   * Returns the directory RELATIVE to that root with `/` separators. Every one of these
   * turns runs with its cwd at the root, so a relative path is what the seat can open,
   * and it stays correct on Windows where `join` would emit backslashes a prompt cannot
   * carry cleanly.
   */
  const writeReviewContext = (review: Review, files: readonly PromptContextFile[]): string => {
    const sessionId = sessionIdForReview(review);
    // The session's BOUND workspace, not the repository root: the returned path is RELATIVE,
    // and a relative path only resolves in the cwd it was written under. Write these under
    // the repository while the turn runs in a worktree and every pointer in every prompt
    // names a file that is not there.
    writeSessionContext(turnRootFor(review), sessionId, files);
    return sessionContextRelativeDir(sessionId);
  };
  /**
   * Hold this review's context files for the life of ONE turn (review finding 2).
   *
   * `session.archive` awaits the session's preparation and nothing else, so every other
   * context-consuming turn — the opener, the PR-body draft, compose, the handoff run,
   * verification, refine, CI classification, noise, the scout, related-context retrieval —
   * could be reading a directory the archive deleted underneath it. Wrapping the turn
   * defers the purge to the last release, so the archive still happens, just not mid-read.
   *
   * The `finally` is the whole contract: a turn that throws must release, or the session's
   * files outlive the archive that asked for them to go.
   */
  const holdingReviewContext = async <T>(review: Review, run: () => Promise<T>): Promise<T> => {
    // BIND FIRST, and here rather than in each turn, because this is the one place every
    // review-scoped turn already passes through. `turnRootFor` below is a synchronous READ of
    // the recorded field, and its fallback is the clone — so a turn that reached it before
    // anything had bound (a session minted before this wave whose first act is a chat, or one
    // whose first bind threw) would run at the clone root and write its context there, which
    // is the very split this wave exists to close. Awaiting the bind is what makes "the next
    // use retries" true rather than a sentence in a comment.
    await bindWorkspaceFor(review);
    const release = contextPurger.turnInFlight(sessionIdForReview(review));
    try {
      return await run();
    } finally {
      release();
    }
  };
  /**
   * The same lease as a producer decorator: every review-scoped turn wired below is the
   * shape `(input: { review }) => Promise<...>`, so one wrap covers all of them and a new
   * producer that forgets the lease is visible at the wiring, not buried in the port.
   */
  const holdingContextFor =
    <I extends { readonly review: Review }, O>(run: (input: I) => Promise<O>) =>
    (input: I): Promise<O> =>
      holdingReviewContext(input.review, () => run(input));
  const roundsRuntime = createRoundsRuntime({
    // One generation's archive (#731 9.3/9.4), taken from the phase records the reveal
    // block already persisted — the spine stays authoritative and unconditional.
    recordBenchmark,
    resolveClaudePort: claudeAdapterForRepo,
    resolveCodexExecutor: codexExecutorForRepo,
    // ALWAYS wired, bundle or no bundle. A board seat has no other backend, so what a
    // daemon owes a lane is the CAUSE: `resolveT3SeatRuntime` asks the supervisor to come
    // up and reports whatever it says, and a supervisor with no bundle path says "the
    // vendored T3 Code server bundle is not built (vendor/t3code/apps/server/dist/bin.mjs)".
    // Leaving the dep off instead made a dev daemon with an unbuilt sidecar report the
    // developer-only "this caller composed no sidecar seam", which names the composition
    // rather than the thing the reader has to fix. A packaged Rennet always has a bundle:
    // `rennet-desktop:build` fails outright when it is not staged.
    resolveT3Seats: options.testT3Seats ?? resolveT3SeatRuntime,
    boardsRuntimeFor,
    readPrompt,
    // session-context-files: the ONE writer, bound by the rounds runtime to the root the
    // seats are DISPATCHED with (`draftingRoot ?? repoRoot`) rather than the session's
    // repository root — which is the session's BOUND workspace, since that is what
    // `draftingRootFor` now answers.
    writeSessionContext: (root, sessionId, files) => {
      const dir = writeSessionContext(root, sessionId, files);
      // The lazy half of the binding (session-bound-workspace, D migration step 4): a session
      // minted before the wave records its workspace the first time something writes in it.
      // `setBoundRoot` keeps a root already recorded, so this never re-decides a binding.
      sessionStore.setBoundRoot(sessionId, root);
      return dir;
    },
    persistBoardMeta: (_repoRoot: string, meta: PersistedBoardMeta) => boardMetaStore.save(meta),
    loadDraftedBoards: (_repoRoot: string, sessionId: string, generation: string) =>
      boardMetaStore.listForGeneration(sessionId, generation),
    removeBoardMeta: (_repoRoot: string, boardId: string) => boardMetaStore.remove(boardId),
    persistGeneration: (gen) => generationStore.save(gen),
    recordRound: (sessionId, record) => roundRecordStore.record(sessionId, record),
    readRounds: (sessionId) => roundRecordStore.read(sessionId),
    loadGeneration: (id) => generationStore.load(id),
    onGenerationTransition: async ({
      repoRoot,
      reviewId,
      sessionId,
      sourceGeneration,
      successorGeneration,
    }) => {
      const readers = {
        loadGeneration: (id: string) => generationStore.load(id),
        listBoardMeta: (ownedSessionId: string, generation: string) =>
          boardMetaStore.listForGeneration(ownedSessionId, generation),
        boardElements: async (boardId: string) => [
          ...(await boardsRuntimeFor(repoRoot).service.getState(boardId)).values(),
        ],
      };
      const [previous, successor] = await Promise.all([
        readPriorGeneration(readers, sessionId, sourceGeneration),
        readPriorGeneration(readers, sessionId, successorGeneration),
      ]);
      if (previous === undefined || successor === undefined) {
        throw new Error("Quote-thread reconciliation could not read both board generations.");
      }
      const events = planQuoteThreadReanchors({
        projection: askLogStore.readProjection(reviewId),
        sourceGeneration,
        successorGeneration,
        previous: new Map(
          LENS_KINDS.flatMap((lens) => {
            const board = previous.boards.get(lens);
            return board === undefined ? [] : [[lens, board] as const];
          }),
        ),
        successor: new Map(
          LENS_KINDS.flatMap((lens) => {
            const board = successor.boards.get(lens);
            return board === undefined ? [] : [[lens, board] as const];
          }),
        ),
      });
      askLogStore.appendMany(reviewId, events);
      if (events.length > 0) {
        wsListener?.broadcastAskProjection(reviewId, askLogStore.readProjection(reviewId));
      }
    },
  });

  /**
   * The deps a generation's boards are drafted through, for ONE review's session.
   *
   * Shared by the two callers, because they differ in exactly ONE thing — whether a coding
   * turn ran first. The gated snapshot the packet fan-in reads, the whole-tree citation
   * inventory lint resolves against, the prior generation carry is decided by, and the
   * rounds runtime itself are identical either way, and were identical when they were
   * written twice.
   */
  const projectContextForBoards = (review: Review, patchset: Patchset) => {
    const repoKey = repoKeyForRoot(review.repositoryRoot);
    const overlayReader = new SnapshotOverlayReader({
      store: liveSnapshotStore,
      overlayStore: new SnapshotOverlayStore(liveSnapshotStore),
    });
    const gated = new ProjectContextReader(liveSnapshotStore, overlayReader).loadFresh(
      repoKey,
      patchset.repository.baseOid,
    );
    const snapshot = gated.ok ? gated.snapshot : null;
    return {
      snapshot,
      revision: sha256Hex(canonicalize({ snapshot: snapshot?.manifest.fingerprint ?? null })),
    };
  };

  const boardDraftingDeps = (
    review: Review,
    session: SessionModel,
    recapture: () => Promise<void>,
    emit: (event: RoundEvent) => void,
    reviewNow: () => Review = () => service.reviewById(review.id) ?? review,
    awaitReport?: (event: Extract<RoundEvent, { readonly type: "report" }>) => void | Promise<void>,
  ): BoardRegenerationDeps => ({
    recapture,
    reviewNow,
    draftingRootFor,
    // The packet's fan-in reads the snapshot gated fresh at the patchset's own
    // base OID. The reader is the OVERLAY-MERGED one: a review on a non-default
    // base resolves through a warmed overlay, and a bare reader would refuse it
    // as stale — two readers disagreeing about the same review's snapshot.
    snapshotFor: (patchset: Patchset) => projectContextForBoards(review, patchset),
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
    // The ROUND half of the archive's deletion boundary. `session.archive` aborts and
    // awaits the session's PREPARATION before sweeping, but a round is driven by the
    // durable coordinator and nothing tracks it — so a returned generation drafting
    // through an archive binds its seat threads AFTER the sweep passed. `sweepIfArchived`
    // re-runs the identical sweep on the way out, and does nothing at all for a session
    // that is still live (the ordinary case: one memoized `load`, no sidecar call).
    runRound: async (input: Parameters<typeof roundsRuntime.runRound>[0]) => {
      // In flight for the duration, so an archive landing mid-round DEFERS its context
      // purge to this settle instead of deleting the directory the next turn reads
      // (review finding 4). Cleared before the sweep, which is what then performs it.
      const settle = contextPurger.turnInFlight(session.id);
      try {
        // The reviewed PR's own paper travels with the generation, so the Design seat's
        // prompt can name `pr.md` (PR #802). Read from the LIVE review — a PR opened after
        // the session was minted still has its paper — and written by the pipeline through
        // the same context sink as the seats' own files, which is what puts it in the root
        // the seats actually run in rather than the repository root alone.
        const prPaper = prPaperContextFile(reviewNow());
        return await roundsRuntime.runRound({
          ...input,
          ...(prPaper === undefined ? {} : { prPaper }),
          ...(awaitReport === undefined ? {} : { onReportProgress: awaitReport }),
        });
      } finally {
        settle();
        await sweepIfArchived(
          sessionStore.load(session.id),
          t3Sidecar.forgetSession,
          purgeContextForSession,
        );
      }
    },
    emit,
  });

  const roundOperationStore = new RoundOperationStore(join(dataDir, "round-operations"));
  const composeRoundBundle = createLiveComposeBundle({
    claudePort: claudeAdapterForRepo,
    codexExecutor: codexExecutorForRepo,
    writeContext: writeReviewContext,
    // The same root the writer wrote under, by construction: the context path the
    // prompt names is relative, so the turn's cwd and the write root are one value.
    turnRoot: turnRootFor,
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

  /**
   * The ONE context key a round's files are written and named under, resolved from the
   * review the operation belongs to. A recovered operation whose review is gone can only
   * name the review id, and the prompt it renders is then compared against nothing — the
   * round is already unreplayable. Both the work-order WRITE and the prompt that NAMES it
   * go through here, because a prompt pointing at a directory nobody wrote is a turn that
   * reads nothing.
   */
  const roundContextKey = (operation: RoundOperation): string => {
    const review = service.reviewById(operation.reviewId);
    return review === null ? operation.reviewId : sessionIdForReview(review);
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
    const contextDir = sessionContextRelativeDir(roundContextKey(operation));
    return mechanicalComposition(
      buildHandoffBundle({
        reviewId: operation.reviewId,
        contextDir,
        patchset,
        dispositions: handoffDispositionsFromProjection(projection, patchset),
      }),
      contextDir,
    );
  };

  const createRoundOperation = (input: {
    readonly session: SessionModel;
    readonly review: Review;
    readonly workOrder: ComposedHandoffBundle;
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
    const records = roundRecordStore.read(input.session.id);
    // The round's work order is a FILE, not a prompt payload (session-context-files, and
    // now that the round is a turn in the session's BOUND root the pointer resolves —
    // which is exactly what the inline exception here was waiting on). Same file name and
    // same context key as `review.handoff.run`. The DOCUMENT rides the durable operation
    // rather than being written here, because the root it belongs in is the one
    // `planWorkspace` resolves a moment later — and writing it at the turn is also what
    // lets a restart put it back.
    //
    // Both are rendered HERE rather than taken from `input.workOrder.prompt`, because a
    // round needs the opposite rule 2 from the review handoff: the handoff recaptures a
    // dirty tree and forbids git, while a round's COMMITS ARE THE ROUND. A round sent the
    // handoff's prompt edits files, leaves nothing committed, and fails at the commit
    // observation — which is what shipped until this was caught in review.
    const roundContextDir = sessionContextRelativeDir(sessionIdForReview(input.review));
    const workOrderDocument = renderWorkOrder(input.workOrder.tasks, ROUND_COMMIT_RULE);
    const workOrderPrompt = renderComposedPrompt(
      input.workOrder.tasks,
      roundContextDir,
      ROUND_COMMIT_RULE,
    );
    return {
      operationId: randomUUID(),
      sessionId: input.session.id,
      reviewId: input.review.id,
      dispatchId: input.dispatchId,
      sourcePatchsetId: input.sourcePatchsetId,
      askOccurrences: [...input.askOccurrences],
      roundNumber: roundNumberForDispatch(records, input.dispatchId),
      sourceTarget:
        patchset.repository.headRef === undefined
          ? { kind: "detached", head: patchset.repository.headOid }
          : { kind: "branch", branch: patchset.repository.headRef },
      repoRoot: input.review.repositoryRoot,
      workOrderPrompt,
      workOrderDocument,
      workOrderDigest: sha256Hex(workOrderPrompt),
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

  const reportHandoffForPublishedOperation = (
    operation: RoundOperation,
  ): RoundReportHandoff | undefined => {
    const state = operation.state;
    if (state.phase === "report-drafting" || state.phase === "report-verifying") {
      return state.report.handoff;
    }
    if (state.phase === "completed" && state.result.kind === "changed") {
      return state.result.report.handoff;
    }
    if (
      state.phase === "failed" &&
      (state.failure.at === "report-drafting" || state.failure.at === "report-verifying")
    ) {
      return state.failure.report.handoff;
    }
    return undefined;
  };

  const publishRoundOperation = (operation: RoundOperation): void => {
    roundProgress.emit(operation.reviewId, {
      type: "operation",
      snapshot: roundOperationProgressSnapshot(operation),
    });
    const handoff = reportHandoffForPublishedOperation(operation);
    const meta = handoff === undefined ? undefined : boardMetaStore.load(handoff.reportBoardId);
    if (
      handoff?.operationId === operation.operationId &&
      handoff.operationRevision === operation.revision &&
      meta !== undefined &&
      meta.boardId === handoff.reportBoardId &&
      meta.lens === "report" &&
      meta.session === operation.sessionId &&
      meta.generation === handoff.generation &&
      JSON.stringify(meta.document) === JSON.stringify(handoff.report.document)
    ) {
      roundProgress.emit(operation.reviewId, {
        type: "report",
        operationId: handoff.operationId,
        operationRevision: handoff.operationRevision,
        reportBoardId: handoff.reportBoardId,
        report: handoff.report,
      });
    }
  };

  // The round runs where the SESSION is bound, never in a per-round worktree
  // (session-bound-workspace D1/D2). A session minted before the binding falls back to the
  // review's own repository root, which is what it would have bound to.
  const readGit = async (root: string, args: readonly string[]): Promise<string | undefined> => {
    try {
      const out = (await gitForRepo(root)(root, [...args], { reject: false })).trim();
      return out.length === 0 ? undefined : out;
    } catch {
      return undefined;
    }
  };
  const planRoundWorkspace = createRoundWorkspacePlanner({
    candidateRoots: (operation) => [
      ...(boundRootForSession(operation.sessionId) === undefined
        ? []
        : [boundRootForSession(operation.sessionId) as string]),
      operation.repoRoot,
    ],
    reviewedHead: (operation) => sourcePatchsetFor(operation).repository.headOid,
    headOf: (root) => readGit(root, ["rev-parse", "HEAD"]),
    branchOf: (root) => readGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    // Resolved, because git prints whichever spelling it was reached by and a worktree and
    // its repository must compare equal here.
    repositoryOf: async (root) => {
      const dir = await readGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      return dir === undefined ? undefined : comparablePath(dir);
    },
    // `merge-base --is-ancestor` answers with its EXIT CODE and prints nothing, so this
    // cannot go through `readGit`, which reads stdout — that reported every root as not
    // containing anything and refused every round.
    containsCommit: async (root, commit) => {
      try {
        await gitForRepo(root)(root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
        return true;
      } catch {
        return false;
      }
    },
  });
  const roundWorkerTurn = createRoundWorkerPort({
    runHandoffTurn: options.runHandoffTurn ?? runHandoffTurn,
  });
  // The work order is written into the root the turn will run in, at the moment the turn
  // starts — the prompt names that exact path (session-context-files). Writing it at
  // dispatch would put it in whichever root the session had recorded then, which is not
  // necessarily the one `planWorkspace` resolved; and writing it here is also what makes a
  // resumed round find the order it was dispatched with rather than nothing at all.
  const runRoundWorker: RoundExecutionPorts["runWorker"] = async (input) => {
    const state = input.operation.state;
    // The LEASE, taken before the write and held until the turn settles: `session.archive`
    // awaits nothing the coordinator drives, so without it an archive mid-turn deletes the
    // work order the agent is reading. The root is remembered for the purge, because it is
    // not necessarily the one the session recorded.
    const release = contextPurger.turnInFlight(input.operation.sessionId);
    try {
      if (state.phase === "worker-running" && input.operation.workOrderDocument !== undefined) {
        roundWorkspaceRoots.set(input.operation.sessionId, state.workspace.root);
        writeSessionContext(state.workspace.root, roundContextKey(input.operation), [
          workOrderContextFileFrom(input.operation.workOrderDocument),
        ]);
      }
      return await roundWorkerTurn(input);
    } finally {
      release();
    }
  };
  const recoverRoundWorker = createRoundWorkerRecoveryPort({
    readCheckpoint: (turn) => readHandoffTurnCheckpoint(turn, t3Sidecar),
  });
  const runRoundGate: RoundExecutionPorts["runGate"] = async ({ operation, attempt }) => {
    if (operation.state.phase !== "gate-running" || operation.gatePlan.kind !== "configured") {
      throw new Error("Configured round gate started without a durable gate plan.");
    }
    const result = await runConfiguredRoundGate({
      locus: locusForRepo(operation.state.workspace.root),
      cwd: operation.state.workspace.root,
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
  };
  const storedRoundReportVerification = {
    reviewById: (reviewId: string) => service.reviewById(reviewId),
    loadGeneration: (generation: string) => generationStore.load(generation),
    loadBoardElements: async (repoRoot: string, boardId: string) => [
      ...(await boardsRuntimeFor(repoRoot).service.getState(boardId)).values(),
    ],
    loadBoardMeta: (boardId: string) => boardMetaStore.load(boardId),
    loadDispatchedAsks: (operation: RoundOperation) =>
      exactWorkOrderFor(operation).tasks.flatMap((task) => task.asks),
  };

  const coordinator = createRoundExecutionCoordinator({
    store: roundOperationStore,
    ports: {
      planWorkspace: planRoundWorkspace,
      observeCommits: async (workspace) =>
        (await readGit(workspace.root, ["rev-parse", "HEAD"])) ?? workspace.sourceHead,
      planWorker: () => ({ executionId: randomUUID(), startedAt: Date.now() }),
      runWorker: runRoundWorker,
      observeWorker: recoverRoundWorker,
      planGate: () => ({ executionId: randomUUID(), startedAt: Date.now() }),
      runGate: runRoundGate,
      observeGate: runRoundGate,
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
        // OBSERVE, never stage: the worker committed on the reviewer's own branch in the
        // bound root, and Rennet does not run `git add -A` on their behalf.
        return observeRoundCommits({
          git: gitForRepo(operation.state.workspace.root),
          root: operation.state.workspace.root,
          executionId: attempt.executionId,
          baseHead: attempt.baseHead,
          startedAt: attempt.startedAt,
        });
      },
      planRoundRecording: (operation) => {
        if (operation.state.phase !== "commits-settled") {
          throw new Error("Round recording planned before its commits settled.");
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
            ...(worker.harness === undefined ? {} : { harness: worker.harness }),
            // The provenance a round now has (round-harness-dispatch): the root the turn
            // ran in and the sidecar checkpoint that captured its commits — never a
            // detached worktree path, because there is no longer one.
            workspaceRoot: operation.state.workspace.root,
            ...(worker.checkpoint === undefined ? {} : { checkpoint: worker.checkpoint }),
            ...(operation.state.workspace.branchRewritten === true
              ? { branchRewritten: true as const }
              : {}),
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
      draftReport: async ({ operation, attempt, recordReportHandoff }) => {
        if (operation.state.phase !== "report-drafting") {
          throw new Error("Round report started outside its durable drafting phase.");
        }
        const sourcePatchset = sourcePatchsetFor(operation);
        // From the BOUND ROOT: that is where the round's turn committed, so that is the
        // tree the successor patchset describes (session-bound-workspace D2).
        const boundRoot = operation.state.workspace.root;
        if (operation.sourceTarget.kind === "branch" && sourcePatchset.source === "local-branch") {
          const base = sourcePatchset.repository.baseRef;
          if (base === undefined) {
            throw new Error("Selected-branch round lost its base branch.");
          }
          const git = gitForRepo(boundRoot);
          const patchset = await captureLandedBranchPatchset({
            git,
            locus: locusForRepo(boundRoot),
            repoPath: boundRoot,
            headRef: operation.sourceTarget.branch,
            baseRef: base,
            headOid: operation.state.commits.to,
            baseOid: sourcePatchset.repository.baseOid,
            resolveProjectSnapshotId: (root, baseOid) =>
              ensureProjectSnapshotPin(liveSnapshotStore, root, baseOid, git),
          });
          await service.activatePatchset(attempt.executionId, operation.reviewId, patchset);
        } else {
          // From the bound root too: the round's commits are in that tree, so a recapture
          // pointed anywhere else describes a tree the round did not write.
          await dispatch("review.regenerate", {
            commandId: attempt.executionId,
            reviewId: operation.reviewId,
            repoPath: boundRoot,
          });
        }
        const review = service.reviewById(operation.reviewId);
        if (review === null) throw new Error("Round recapture did not return its review.");
        const session = sessionForOperation(operation);
        const workOrder = exactWorkOrderFor(operation);
        const previousGeneration = currentGenerationId(
          roundRecordStore.read(session.id),
          operation.sourcePatchsetId,
        );
        let progressOperation = {
          operationId: operation.operationId,
          operationRevision: operation.revision,
        };
        const progress = createRoundRegenerationProgressQueue({
          onDiagnostic: (event) => {
            roundProgress.emit(operation.reviewId, { ...event, ...progressOperation });
          },
          onReport: async (event) => {
            await verifyStoredRoundReport(storedRoundReportVerification, operation, {
              point: "precommit",
              reportBoardId: event.reportBoardId,
              generation: attempt.generation,
              expectedPatchsetId: review.activePatchsetId,
            });
            const meta = boardMetaStore.load(event.reportBoardId);
            if (
              meta === undefined ||
              meta.boardId !== event.reportBoardId ||
              meta.lens !== "report" ||
              meta.session !== operation.sessionId ||
              meta.generation !== attempt.generation
            ) {
              throw new Error("Round report progress lost its durable board identity.");
            }
            const reportElements = await boardsRuntimeFor(operation.repoRoot).service.getState(
              event.reportBoardId,
            );
            const report = projectRoundReportBoard([...reportElements.values()], {
              lens: "report",
              generation: attempt.generation,
              boardId: event.reportBoardId,
              document: meta.document,
            });
            const handoff = recordReportHandoff({
              reportBoardId: event.reportBoardId,
              generation: attempt.generation,
              report,
            });
            progressOperation = {
              operationId: handoff.operationId,
              operationRevision: handoff.operationRevision,
            };
          },
          onLens: (event) => {
            roundProgress.emit(operation.reviewId, { ...event, ...progressOperation });
          },
        });
        // The round's code has LANDED and been re-captured by the time this step runs, so
        // this is the moment the reviewer starts waiting for a board (#725 D4). The
        // rounds runtime cannot know it — from in there, the wait looks like it starts
        // after board minting and provider resolution.
        const firstBoardWaitOriginMs = Date.now();
        const regenerated = await runBoardRegeneration(
          boardDraftingDeps(
            review,
            session,
            async () => undefined,
            progress.emit,
            undefined,
            progress.emit,
          ),
          {
            session,
            repoRoot: operation.repoRoot,
            firstBoardWaitOriginMs,
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
            verifyDraftedReport: async ({ reportBoardId, generation, patchsetId }) => {
              if (reportBoardId !== attempt.reportBoardId || generation !== attempt.generation) {
                throw new Error("Round regeneration drafted outside its reserved report identity.");
              }
              await verifyStoredRoundReport(storedRoundReportVerification, operation, {
                point: "precommit",
                reportBoardId,
                generation,
                expectedPatchsetId: patchsetId,
              });
            },
            draftPlan: { generation: attempt.generation, boardIds: attempt.boardIds },
            recaptured: true,
          },
        );
        await progress.settle();
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
        if (operation.state.phase !== "report-verifying") {
          throw new Error(
            "Round report verification started outside its durable verification phase.",
          );
        }
        const generation = generationStore.load(report.generation);
        if (generation === undefined) {
          throw new Error("Round report verification lost its persisted generation.");
        }
        await verifyStoredRoundReport(storedRoundReportVerification, operation, {
          point: "persisted",
          reportBoardId: report.reportBoardId,
          generation: report.generation,
          expectedPatchsetId: generation.patchsetId,
        });
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
          if (operation.state.returnedAt !== undefined) return { kind: "retain" };
          const session = sessionForOperation(operation);
          const returnRow = roundReturnTranscriptRow(operation);
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
              onProgress: (event) => {
                if (event.type === "failed") roundProgress.emit(operation.reviewId, event);
              },
            });
          }
          if (returnRow !== undefined) appendRoundTranscript(session.id, [returnRow]);
          consumeCurrentAskOccurrences(
            {
              askLog: askLogStore,
              broadcastAskProjection: (reviewId, projection) =>
                wsListener?.broadcastAskProjection(reviewId, projection),
            },
            operation.reviewId,
            operation.askOccurrences,
          );
          // This legacy receipt follows both durable Return and exact ask consumption.
          // New clients wait for `returnedAt`; older clients still see the same event order.
          if (returnRow !== undefined) {
            roundProgress.emit(
              operation.reviewId,
              operation.state.result.kind === "changed"
                ? {
                    type: "composed",
                    generation: operation.state.result.report.generation,
                  }
                : { type: "unchanged" },
            );
          }
        }
        if (!operation.rerunRequested) {
          if (operation.state.phase !== "completed") return { kind: "retain" };
          return {
            kind: "return",
            returnedAt: Math.max(Date.now(), operation.state.completedAt),
          };
        }
        const review = service.reviewById(operation.reviewId);
        if (review === null) throw new Error("Queued round lost its review.");
        const draft = activeRoundDraft(
          askLogStore.read(review.id),
          review.id,
          activePatchsetFor(review),
          sessionContextRelativeDir(sessionIdForReview(review)),
        );
        if (draft === undefined) return { kind: "clear-queued" };
        const workOrder = await holdingReviewContext(review, () =>
          composeRoundBundle({
            bundle: draft.bundle,
            review,
            contextDir: sessionContextRelativeDir(sessionIdForReview(review)),
          }),
        );
        const replacement = createRoundOperation({
          session: sessionForOperation(operation),
          review,
          workOrder,
          dispatchId: draft.dispatchId,
          sourcePatchsetId: draft.bundle.patchsetId,
          askOccurrences: draft.askOccurrences,
        });
        appendRoundTranscript(replacement.sessionId, [roundDispatchTranscriptRow(replacement)]);
        return { kind: "replace", operation: replacement };
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
  async function draftBoardsForReview(
    review: Review,
    emit: (event: RoundEvent) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // The captured input is READY — this is where the reviewer's wait for a first board
    // starts (#725 D4), ahead of the session entry, the collation and every mint.
    const firstBoardWaitOriginMs = Date.now();
    const patchset = review.patchsets.find((p) => p.id === review.activePatchsetId);
    if (patchset === undefined) return false;
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
    // Supersession is NOT caught here (#816 re-review P1). A `false` return means "did not
    // settle", and the coordinator turns that into a `did not settle` throw that
    // `runSessionPreparation` paints as a FAILED preparation. But a superseded attempt did not
    // fail — a later attempt owns this generation. Let `GenerationSupersededError` propagate
    // through the coordinator so preparation exits without painting failure. A genuine drafting
    // failure still throws its own error and still paints failed, as it should.
    const settled = await runBoardRegeneration(
      boardDraftingDeps(
        review,
        session,
        // No coding turn ran, so there is nothing to re-capture. `runBoardRegeneration`
        // only calls this when checkpoint evidence says the tree changed, which it never does here.
        async () => undefined,
        // Initial drafting has its own durable session-preparation channel. It still consumes
        // the exact RoundEvent snapshots emitted by the lens runtime; it never fabricates a
        // reviewer-dispatched round to make them render.
        emit,
        // Passive drafting belongs to this exact captured version. A regenerate can advance the
        // live review while this model work is running; letting `reviewNow` observe that successor
        // turns the old no-work A→A draft into a phantom A→B round. Pin A here, then report
        // failure below if B became current so the B coordinator owns the live composition.
        () => review,
      ),
      {
        session,
        repoRoot: review.repositoryRoot,
        firstBoardWaitOriginMs,
        // The review's OWN patchset is the prior: nothing moved, so this drafts the first
        // generation over it rather than minting a successor to something that never ran.
        priorPatchsetId: review.activePatchsetId,
        // A completed round can make a non-content-addressed generation current for this
        // patchset. Context refresh must redraft the generation the board route actually reads.
        priorGenerationId: currentGenerationId(
          roundRecordStore.read(session.id),
          review.activePatchsetId,
        ),
        asksDispatched: [],
        worked: { commitRange: { from: head, to: head }, diff: "", changedPaths: [] },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return settled && service.reviewById(review.id)?.activePatchsetId === review.activePatchsetId;
  }

  const ensureBoardDrafting = createBoardDraftCoordinator(draftBoardsForReview, (review) => {
    const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
    return patchset === undefined
      ? `missing:${review.activePatchsetId}`
      : projectContextForBoards(review, patchset).revision;
  });

  /** Kick board drafting behind a review version becoming current. The command has already
   *  persisted the version; drafting is single-flight and never turns capture/regenerate into a
   *  failed command. A later compose can join or retry the same recovery path. */
  const kickBoardDrafting = (review: Review): void => {
    // `pr.md` is NOT written here. It rides the generation as `prPaper` and goes through
    // the pipeline's own context sink, which is bound to the root the seats are dispatched
    // with — a PR-snapshot review drafts in a worktree, and a copy written at the
    // repository root is one the Design seat's prompt does not name.
    void ensureBoardDrafting(review).catch(() => undefined);
  };

  // Start background maintenance once composition is live. A queued or running
  // initial journal resumes under its durable command id; completed/legacy projects
  // enter the normal baseline watcher. Failed runs stay visible for the in-place Retry action.
  startProjectContextMaintenance({
    projects: projectStore.list(),
    loadRun: (project) => {
      const primaryPath = project.openPath || project.path;
      return projectProcessJournal.load(repoKeyForRoot(primaryPath));
    },
    resume: (project, runId) =>
      processProjectCore({ projectId: project.id, commandId: runId }, (event) => {
        options.broadcastProgress?.(runId, event);
        wsListener?.broadcastProgress(runId, event);
      }),
    rehydrate: (project) => rehydration.ensureForProject(project),
    onError: (error) => console.error("Project processing resume failed", error),
  });

  type PreparationTarget = {
    readonly branch: string;
    readonly prNumber?: number;
    readonly repository?: string;
    readonly forgeRepository?: ForgeRepoIdentity;
  };
  type PreparationRequest = {
    readonly projectId: string;
    readonly commandId: string;
    readonly target?: PreparationTarget;
    readonly reviewId?: string;
  };
  const initialPreparationLanes = (): LensLane[] =>
    LENS_KINDS.map((lens) => ({
      id: lens,
      label: `${lens[0]?.toUpperCase() ?? ""}${lens.slice(1)}`,
      status: "queued",
    }));
  const preparationIsCurrent = (sessionId: string, controller: AbortController): boolean =>
    sessionPreparations.get(sessionId) === controller && !controller.signal.aborted;
  const waitForPreparationDelay = async (
    rawDelay: string | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    const delayMs = Number(rawDelay ?? 0);
    if (!Number.isFinite(delayMs) || delayMs <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delayMs);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  };
  const setCurrentPreparation = (
    sessionId: string,
    controller: AbortController,
    preparation: SessionPreparation | undefined,
  ): SessionModel | undefined =>
    preparationIsCurrent(sessionId, controller)
      ? sessionStore.setPreparation(sessionId, preparation)
      : sessionStore.load(sessionId);

  async function runSessionPreparation(
    sessionId: string,
    request: PreparationRequest,
    controller: AbortController,
  ): Promise<void> {
    let stage: "capture" | "boards" = request.reviewId === undefined ? "capture" : "boards";
    let review: Review | null =
      request.reviewId === undefined ? null : service.reviewById(request.reviewId);
    let lanes = initialPreparationLanes();
    try {
      if (review === null) {
        await waitForPreparationDelay(
          env.RENNET_TEST_CAPTURE_PREPARATION_DELAY_MS,
          controller.signal,
        );
        if (!preparationIsCurrent(sessionId, controller)) return;

        const project = projectStore.list().find((entry) => entry.id === request.projectId);
        const target = request.target;
        const rowRepository =
          target?.repository ??
          (target?.forgeRepository === undefined
            ? undefined
            : forgeRepositorySlug(target.forgeRepository));
        const resolvedRoot =
          target === undefined
            ? undefined
            : await resolveProjectRepositoryRoot({
                project,
                target,
                identityForRoot: (root) => repositoryIdentity(gitForRepo(root), root),
              });
        if (!preparationIsCurrent(sessionId, controller)) return;
        const rootDecision = resolveCaptureRoot(project, rowRepository, resolvedRoot);
        if ("error" in rootDecision) throw new Error(rootDecision.error);
        const root = rootDecision.root;
        setCurrentPreparation(sessionId, controller, {
          status: "capturing",
          step: "capturing-change",
        });
        if (target === undefined) watcher.setDirty(false);
        if (target === undefined) {
          review = await service.capture(request.commandId, root);
        } else if (target.prNumber === undefined) {
          review = await captureBranch(
            request.commandId,
            root,
            target.branch,
            project?.primaryBranch ?? "HEAD",
          );
        } else {
          review =
            target.forgeRepository === undefined
              ? await openPullRequest(
                  request.commandId,
                  `${target.repository ?? ""}#${target.prNumber}`,
                  root,
                  false,
                )
              : await openProjectPullRequest(projectPullRequestOpeners, {
                  commandId: request.commandId,
                  repository: target.forgeRepository,
                  number: target.prNumber,
                  repoPath: root,
                  retrospective: false,
                });
        }
        await waitForPreparationDelay(
          env.RENNET_TEST_CAPTURE_SETTLEMENT_DELAY_MS,
          controller.signal,
        );
        if (sessionPreparations.get(sessionId) !== controller) return;
        allowedRoots.add(review.repositoryRoot);
        if (target === undefined) {
          watcher.start(review.repositoryRoot, locusForRepo(review.repositoryRoot));
        }
        const current = sessionStore.load(sessionId);
        if (current !== undefined && current.repositoryRoot === undefined) {
          sessionStore.save({ ...current, repositoryRoot: review.repositoryRoot });
        }
        sessionStore.attachReview(sessionId, review.id);
        // The binding is decided HERE, once, the moment the review names a target
        // (session-bound-workspace D1) — not at the first seat, so the reviewer can see which
        // workspace the session owns before anything drafts in it. A worktree that cannot be
        // created FAILS the preparation with its reason rather than binding the session to the
        // clone: retrying the preparation retries the bind, and every later use binds lazily
        // through `holdingReviewContext` if this one never ran.
        await bindWorkspaceFor(review);
        if (controller.signal.aborted) {
          sessionStore.setPreparation(sessionId, {
            status: "cancelled",
            stage: "boards",
            reviewId: review.id,
            lanes,
          });
          return;
        }
      }

      if (review === null) throw new Error("The captured review could not be loaded.");
      const draftingReview = review;
      stage = "boards";
      setCurrentPreparation(sessionId, controller, {
        status: "drafting",
        reviewId: draftingReview.id,
        lanes,
      });
      await waitForPreparationDelay(env.RENNET_TEST_BOARD_PREPARATION_DELAY_MS, controller.signal);
      if (!preparationIsCurrent(sessionId, controller)) return;
      let terminalReason: string | undefined;
      try {
        await ensureBoardDrafting(
          draftingReview,
          (event) => {
            if (!preparationIsCurrent(sessionId, controller)) return;
            if (event.type === "failed") terminalReason = event.reason;
            if (event.type !== "lens") return;
            lanes = [...event.lanes];
            setCurrentPreparation(sessionId, controller, {
              status: "drafting",
              reviewId: draftingReview.id,
              lanes,
            });
          },
          controller.signal,
        );
      } catch (error) {
        if (terminalReason !== undefined) throw new Error(terminalReason, { cause: error });
        throw error;
      }
      if (!preparationIsCurrent(sessionId, controller)) return;
      setCurrentPreparation(sessionId, controller, undefined);
    } catch (error) {
      if (!preparationIsCurrent(sessionId, controller)) return;
      // A superseded drafting attempt did NOT fail (#816 re-review P1): a later attempt owns
      // this review's generation and will compose it. Painting `failed` here would show the
      // reviewer a failure for a draft that was merely overtaken — the passive counterpart of
      // the active path's abandon in round-execution.ts. Clear the in-flight status, the same
      // exit the success path takes, and let the owning attempt file the boards.
      if (error instanceof GenerationSupersededError) {
        setCurrentPreparation(sessionId, controller, undefined);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      setCurrentPreparation(sessionId, controller, {
        status: "failed",
        stage,
        reason,
        ...(review === null ? {} : { reviewId: review.id }),
        ...(stage === "boards" ? { lanes } : {}),
      });
    } finally {
      if (sessionPreparations.get(sessionId) === controller) {
        sessionPreparations.delete(sessionId);
      }
    }
  }

  function beginSessionPreparation(
    session: SessionModel,
    request: PreparationRequest,
  ): SessionModel {
    sessionPreparations.get(session.id)?.abort("Preparation restarted.");
    const controller = new AbortController();
    sessionPreparations.set(session.id, controller);
    const preparation: SessionPreparation =
      request.reviewId === undefined
        ? { status: "capturing", step: "resolving-repository" }
        : { status: "drafting", reviewId: request.reviewId, lanes: initialPreparationLanes() };
    const prepared = sessionStore.setPreparation(session.id, preparation) ?? session;
    const run = runSessionPreparation(session.id, request, controller).finally(() => {
      if (sessionPreparationRuns.get(session.id) === run) {
        sessionPreparationRuns.delete(session.id);
      }
    });
    sessionPreparationRuns.set(session.id, run);
    void run;
    return prepared;
  }

  function cancelSessionPreparation(sessionId: string): SessionModel | undefined {
    const session = sessionStore.load(sessionId);
    const preparation = session?.preparation;
    if (
      session === undefined ||
      (preparation?.status !== "capturing" && preparation?.status !== "drafting")
    ) {
      return session;
    }
    sessionPreparations.get(sessionId)?.abort("Cancelled by reviewer.");
    return sessionStore.setPreparation(sessionId, {
      status: "cancelled",
      stage: preparation.status === "capturing" ? "capture" : "boards",
      ...(preparation.status === "drafting"
        ? { reviewId: preparation.reviewId, lanes: preparation.lanes }
        : {}),
    });
  }

  async function retrySessionPreparation(
    sessionId: string,
    commandId: string,
  ): Promise<SessionModel | undefined> {
    await sessionPreparationRuns.get(sessionId)?.catch(() => undefined);
    const session = sessionStore.load(sessionId);
    if (session === undefined) return undefined;
    const preparation = session.preparation;
    if (preparation?.status === "capturing" || preparation?.status === "drafting") return session;
    const retryReviewId =
      preparation !== undefined && "reviewId" in preparation
        ? preparation.reviewId
        : session.reviewId;
    return beginSessionPreparation(session, {
      projectId: session.projectId,
      commandId,
      ...(session.claim === undefined
        ? {}
        : {
            target: {
              ...session.claim,
              ...(session.repository === undefined ? {} : { repository: session.repository }),
              ...(session.forgeRepository === undefined
                ? {}
                : { forgeRepository: session.forgeRepository }),
            },
          }),
      ...(retryReviewId === undefined ? {} : { reviewId: retryReviewId }),
    });
  }

  const readLensBoardForReview = async (reviewId: string, generation: string, lens: LensKind) => {
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
    });
  };

  dispatch = createDispatch({
    t3Sidecar,
    // The lines a truncated capture cut short, read from the immutable object the patchset
    // recorded rather than the working tree (`patchset.readSpan`). Best-effort: a missing
    // repository, object or path answers `null` and the reader captions the gap.
    readBlobAtOid: async ({ root, oid, path }) => {
      try {
        return await gitForRepo(root)(root, ["show", `${oid}:${path}`]);
      } catch {
        return null;
      }
    },
    // Archive is the deletion boundary for the session's context files as much as for its
    // threads; the host resolves the bound root the wire never carries.
    purgeSessionContext: purgeContextForSession,
    boundWorkspaceForReview,
    // The ONE key a review's context files live under — the same id `purgeSessionContext`
    // is called with, so the handoff work order the dispatch writes is the one the archive
    // purges and the orphan sweep spares (review finding 1).
    reviewContextSessionId: sessionIdForReview,
    // ...and the lease that keeps a mid-flight turn's files alive through an archive
    // (review finding 2). The last release performs a purge the archive deferred.
    holdSessionContext: (sessionId) => contextPurger.turnInFlight(sessionId),
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
        // The enrichment seat's candidate dossier: a RUN-SCOPED file under this review's
        // session context directory, not `candidates.json` in the global dossier store
        // (review finding 3). Under the session, the archive purge covers it; run-scoped,
        // a concurrent open of the same target cannot overwrite the file the first seat is
        // reading; discarded below, because it exists only for the turn that reads it.
        const written: { discard(): void }[] = [];
        // The retrieval seat reads the dossier file this writes, so the lease is held for
        // the whole kick — an archive landing mid-retrieval defers its purge (finding 2).
        // The `catch` on the voided promise is what the `try` below cannot do: it only sees a
        // synchronous throw, and the lease now BINDS the workspace first, which rejects when
        // the workspace cannot be made. Without it a failed kick is an unhandled rejection
        // rather than the garnish the comment below promises.
        void holdingReviewContext(review, () =>
          runRelatedContextRetrieval(review, {
            store: snapshotStore,
            resolveClaudePort: claudeAdapterForRepo,
            resolveCodexExecutor: codexExecutorForRepo,
            trackerConfig: resolveTrackerConfig(
              snapshotStore,
              repoKeyOf(review),
              daemonSettingsStore.readState().config,
            ),
            writeCandidates: (items) => {
              const file = writeRunScopedContext(
                review.repositoryRoot,
                sessionIdForReview(review),
                `related-context-candidates-${randomUUID()}.json`,
                `${serializeDossier(items)}\n`,
              );
              // `file.path` is RELATIVE to the bound root: the enrichment prompt names it
              // verbatim and the seat's cwd IS that root, so an absolute daemon-locus path
              // would be unopenable from a WSL distro seat (review finding 4).
              written.push(file);
              return file.path;
            },
          }).finally(() => {
            for (const file of written) file.discard();
          }),
        ).catch(() => undefined);
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
    publishPortFor: (repository, repositoryRoot) =>
      repository.forge === "gitlab"
        ? gitLabForgeAdapterForRoot(repositoryRoot)
        : repository.forge === "github"
          ? githubReviewPublisher
          : undefined,
    publishReceipts: publishReceiptStore,
    resolvePullRequestDestination,
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
    // The live round-progress catch-up read (C15 3.1). The durable operation remains the
    // authority; its operation-scoped report/lens log stays beside the drafting, verification,
    // and terminal snapshots so the client can select the latest attempt, read the verified
    // report while lenses run, and keep their settled account at completion.
    roundEventsForReview: (reviewId: string) => {
      const review = service.reviewById(reviewId);
      if (review === null) return [];
      const operation = roundOperationStore.read(sessionIdForReview(review));
      if (operation === undefined) return roundProgress.read(reviewId);
      return roundEventsForDurableOperation({
        operation,
        liveEvents: roundProgress.read(reviewId),
        reportHandoffIsReadable: (handoff) => {
          const meta = boardMetaStore.load(handoff.reportBoardId);
          return (
            meta !== undefined &&
            meta.boardId === handoff.reportBoardId &&
            meta.lens === "report" &&
            meta.session === operation.sessionId &&
            meta.generation === handoff.generation &&
            JSON.stringify(meta.document) === JSON.stringify(handoff.report.document)
          );
        },
      });
    },
    // The sidebar's sessions (C03 cluster 2, bound in C18), served from the SAME durable
    // session store the round dispatch mints into — so a session the reviewer worked in is
    // the session the sidebar lists. Every write persists through the store, so a rename, a
    // pin, and an archive all survive reload; restore is un-archive.
    sessions: {
      list: () => sessionStore.list().map(sidebarSessionFor),
      // Mint first and return immediately. The durable preparation snapshot owns the capture
      // and first-generation work after navigation, including cancellation, retry, restart
      // recovery, and the exact lens events emitted by the server pipeline.
      start: async ({ projectId, commandId, replacesSessionId, target }) => {
        const legacyPrRef =
          target?.prNumber === undefined || target.forgeRepository !== undefined
            ? null
            : parseGitHubPrRef(`${target.repository ?? ""}#${target.prNumber}`);
        const identityTarget =
          target === undefined || legacyPrRef === null
            ? target
            : {
                ...target,
                repository: forgeRepositorySlug(legacyPrRef.repo),
                forgeRepository: legacyPrRef.repo,
              };
        const entered =
          target === undefined
            ? { session: mintSession(projectId), reattached: false }
            : replacesSessionId === undefined
              ? sessionEntry.enter(projectId, identityTarget ?? target)
              : sessionEntry.enterSuccessor(replacesSessionId, projectId, identityTarget ?? target);
        if (!entered.reattached) sessionStore.save(entered.session);
        const current = sessionStore.load(entered.session.id) ?? entered.session;
        const prepared =
          entered.reattached &&
          (current.reviewId !== undefined ||
            current.preparation?.status === "capturing" ||
            current.preparation?.status === "drafting" ||
            current.preparation?.status === "failed" ||
            current.preparation?.status === "cancelled")
            ? current
            : beginSessionPreparation(current, {
                projectId,
                commandId,
                ...(identityTarget === undefined ? {} : { target: identityTarget }),
              });
        if (replacesSessionId !== undefined) sessionStore.archive(replacesSessionId);
        return { session: sidebarSessionFor(prepared), reattached: entered.reattached };
      },
      cancelPreparation: (sessionId) => {
        const session = cancelSessionPreparation(sessionId);
        return session && sidebarSessionFor(session);
      },
      retryPreparation: async (sessionId, commandId) => {
        const session = await retrySessionPreparation(sessionId, commandId);
        return session && sidebarSessionFor(session);
      },
      rename: (sessionId, title) => {
        const session = sessionStore.rename(sessionId, title);
        return session && sidebarSessionFor(session);
      },
      setPinned: (sessionId, pinned) => {
        const session = sessionStore.setPinned(sessionId, pinned);
        return session && sidebarSessionFor(session);
      },
      setArchived: async (sessionId, archived) => {
        // Archiving establishes a DELETION BOUNDARY (review finding 2). The sweep that
        // follows deletes this session's threads, so anything still able to BIND one has
        // to be over first: a preparation mid-flight would otherwise bind a fresh seat
        // thread after the sweep had already passed, and the archive would leave exactly
        // the orphan it exists to prevent. Same abort-then-await the retry path uses.
        if (archived) {
          cancelSessionPreparation(sessionId);
          await sessionPreparationRuns.get(sessionId)?.catch(() => undefined);
        }
        const session = archived
          ? sessionStore.archive(sessionId)
          : sessionStore.restore(sessionId);
        return session && sidebarSessionFor(session);
      },
    },
    // The lens-board read for `board.read` (C05 cluster 8, C18): the board this review's
    // session drafted for `(generation, lens)`, rebuilt from its two durable halves — the
    // board-meta record (which board id, and the document opening the element
    // vocabulary cannot carry) and the whiteboard event log's projected element state.
    // Session identity is the SAME read-only target-claim derivation the rounds/transcript
    // reads use. No meta record ⇒ that lens drafted no board that generation ⇒ honest
    // missing, never a fabricated board.
    lensBoardForReview: readLensBoardForReview,
    compositionBoardsForReview: createCompositionBoardsForReview({
      reviewById: (reviewId) => service.reviewById(reviewId) ?? undefined,
      loadGeneration: (generation) => generationStore.load(generation),
      ensureBoardDrafting,
      readLensBoard: readLensBoardForReview,
    }),
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
    lensFailureForReview: async (reviewId: string, generation: string, lens: LensKind) => {
      const review = service.reviewById(reviewId);
      if (!review) return undefined;
      const stored = generationStore.load(generation);
      if (
        stored === undefined ||
        !review.patchsets.some((patchset) => patchset.id === stored.patchsetId)
      ) {
        return undefined;
      }
      const message = stored.failedLenses?.[lens];
      if (message === undefined) return undefined;
      const account = stored.failedLensAccounts?.[lens];
      return { message, ...(account === undefined ? {} : { account }) };
    },
    retryRound: async ({ review }) => {
      const sessionId = sessionIdForReview(review);
      const failed = roundOperationStore.read(sessionId);
      if (failed?.state.phase !== "failed") return undefined;

      const retry = roundRetryMode(failed.state.failure);
      const settled = coordinator.retry(sessionId);
      const accepted = roundOperationStore.read(sessionId);
      if (accepted === undefined || accepted.operationId !== failed.operationId) {
        throw new Error("Round retry was not durably accepted.");
      }
      void settled.catch((error) => {
        console.error("Durable round retry failed", error);
      });
      return {
        retry,
        acceptedOperation: roundOperationProgressSnapshot(accepted),
      };
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
        if (
          active === undefined ||
          active.state.phase === "failed" ||
          (active.state.phase === "completed" && active.state.returnedAt !== undefined)
        ) {
          return undefined;
        }
        if (active.dispatchId === dispatchId || active.rerunRequested) {
          void coordinator.resume(session.id).catch((error) => {
            console.error("Durable round resume failed", error);
          });
          return roundOperationProgressSnapshot(active);
        }
        try {
          const queued = roundOperationStore.requestRerun({
            sessionId: active.sessionId,
            operationId: active.operationId,
            revision: active.revision,
          });
          publishRoundOperation(queued);
          void coordinator.resume(session.id).catch((error) => {
            console.error("Queued durable round recovery failed", error);
          });
          return roundOperationProgressSnapshot(queued);
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
      const operation = createRoundOperation({
        session,
        review,
        workOrder,
        dispatchId,
        sourcePatchsetId,
        askOccurrences,
      });
      appendRoundTranscript(session.id, [roundDispatchTranscriptRow(operation)]);
      const settled = coordinator.submit(operation);
      const accepted = roundOperationStore.read(session.id);
      if (accepted === undefined) {
        throw new Error("Round dispatch was not durably accepted.");
      }
      return {
        askDrain: "coordinator",
        acceptedOperation: roundOperationProgressSnapshot(accepted),
        settled: settled.then(() => undefined),
      };
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
        writeContext: writeReviewContext,
        // The same root the writer wrote under, by construction: the context path the
        // prompt names is relative, so the turn's cwd and the write root are one value.
        turnRoot: turnRootFor,
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
    // The complete add-project run: persisted scout facts first, then the
    // structural map. The command does not resolve until that advertised run
    // is terminal, so the header, timeline, sidebar, and ready card share one fact.
    processProject: async (input, emit) => {
      const result = await processProjectCore(
        { projectId: input.projectId, commandId: input.commandId },
        emit,
      );
      // Once the initial run is terminal, start the idempotent baseline watcher.
      const processed = projectStore.list().find((entry) => entry.id === input.projectId);
      if (processed && result.run?.status === "done") {
        void rehydration?.ensureForProject(processed);
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
      const { source, credentialSource, authUnavailable, authUnavailableCopy } =
        await resolveProjectPrSource();
      const githubProjectRegistry = createForgeRegistry<ProjectPrSource>(
        source === null ? [] : [{ forge: "github", implementation: source }],
      );
      const forgeRegistry = {
        sourceFor(repository: ForgeRepoIdentity, repositoryRoot: string) {
          return repository.forge === "gitlab"
            ? gitLabForgeAdapterForRoot(repositoryRoot)
            : githubProjectRegistry.sourceFor(repository);
        },
      };
      const detail = await loadProjectDetail(
        defaultProjectDetailSourceDeps(gitForRepo(projectRoot), forgeRegistry),
        project,
        prStates,
        emit,
      );
      const finalAuthUnavailable = authUnavailable ?? detail.authUnavailable;
      if (!finalAuthUnavailable) return detail;
      return {
        ...detail,
        authUnavailable: finalAuthUnavailable,
        ...(credentialSource === undefined ? {} : { authUnavailableSource: credentialSource }),
        ...(authUnavailableCopy === undefined ? {} : { authUnavailableCopy }),
      };
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
    // The Flagged lens (issue #138): the automated review layer's findings. This is
    // the LIVE finding-generation runner (#32) — a real model turn over the review's
    // diff. Dual-review aggregation (#41) + per-finding verification (#179) run by
    // DEFAULT now (Rai's mandate, 2026-08-11); an explicit opt-down gives single-Claude
    // quick. The boundary is unchanged.
    // Wrapped in the context lease: the DEEP path writes verification pointers and CI
    // pointers into the session directory and reads them from a seat (review finding 2).
    flaggedReview: (review, deepReview, session) =>
      holdingReviewContext(review, () => runFlaggedReview(review, deepReview, session)),
    // The Noise lens (issue #34): the low-signal churn grouped away, each group tagged
    // rule vs noise job. This is the LIVE noise-classification runner — a real model
    // turn over the review's diff, replacing the fixture, behind the unchanged
    // `noiseReview` boundary. The deterministic mechanical-rules engine (a separate
    // admission authority for the `rule` groups) is a DEFERRED follow-up; the empty-
    // vs-failed distinction and the totality-floor ejection are honoured today.
    noiseReview: (review) => holdingReviewContext(review, () => runNoiseReview(review)),
    // The Spec angle's live source (wireframes #9): parse-on-open of the change the
    // reviewed patchset selected, read from the review's checked-out root. Deterministic
    // and model-free — no gate, no spend. `null` when the review touches no
    // `openspec/changes/<name>/`, replacing the frozen fixture with the real change.
    openSpecChange: (review) => {
      const patchset = activePatchset(review);
      return readOpenSpecChange(patchset, gitForRepo(patchset.repository.root));
    },
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
    // review.refine (issue #19): the LIVE comment-refinement producer. Rai's
    // headline feature — a rough note refined into a clean comment by a real,
    // council-routed model turn. Runs on WHICHEVER seat the council resolves: Codex
    // (Terra) when installed — the same absolute-binary resolution the ask-AI
    // executor and pipeline seat use (bead workspace-6qp15) — else the Claude
    // adapter (a light read-only session with the inline schema, the same
    // structured-output mechanism every pipeline lens seat uses; no docType).
    refineComment: holdingContextFor(
      createLiveRefinePort({
        claudePort: claudeAdapterForRepo,
        codexExecutor: codexExecutorForRepo,
        writeContext: writeReviewContext,
        // The same root the writer wrote under, by construction: the context path the
        // prompt names is relative, so the turn's cwd and the write root are one value.
        turnRoot: turnRootFor,
      }),
    ),
    // review.draftPrBody (issue #74, M26): the LIVE PR-body drafting producer. The
    // own-branch destination's paper opens with an HONEST ACCOUNT of the change,
    // drafted by a real, council-routed model turn. Runs on WHICHEVER seat the
    // council resolves for `pr-body-draft` (Codex Luna when installed, else the
    // Claude adapter) — the SAME seat probes the refine producer uses (bead
    // workspace-6qp15). Degrades to an honest `unavailable` (the deterministic
    // composed body still previews) when neither seat is installed. Posts NOTHING.
    draftPrBody: holdingContextFor(
      createLiveDraftPrBodyPort({
        claudePort: claudeAdapterForRepo,
        codexExecutor: codexExecutorForRepo,
        writeContext: writeReviewContext,
        // The same root the writer wrote under, by construction: the context path the
        // prompt names is relative, so the turn's cwd and the write root are one value.
        turnRoot: turnRootFor,
      }),
    ),
    // publish.compose(mode:"review") (#621): the authored opening paragraph is drafted from
    // active persisted boards plus the durable ask projection. The content-addressed store keeps
    // unchanged evidence byte-stable across remounts and restarts, preserving the post marker's
    // outcome-unknown retry identity. A changed verdict, ask, or board legitimately redrafts.
    draftReviewOpener: holdingContextFor(
      options.draftReviewOpener ??
        createLiveReviewOpenerPort({
          claudePort: claudeAdapterForRepo,
          codexExecutor: codexExecutorForRepo,
          readPrompt,
          store: publishCompositionStore,
          writeContext: writeReviewContext,
          // The same root the writer wrote under, by construction: the context path the
          // prompt names is relative, so the turn's cwd and the write root are one value.
          turnRoot: turnRootFor,
        }),
    ),
    // review.deltaDigest (issue #73 / M25): the LIVE delta re-review digest producer.
    // Rephrases the successor review's DETERMINISTIC successor account into a one-glance
    // TL;DR shown ON TOP of the facts, on WHICHEVER seat the council resolves for
    // `delta-rereview-summary` — the SAME probes the drafter uses. Degrades to an honest
    // `unavailable` (the facts still render, no headline) when neither seat is installed.
    // Fed ONLY the structured account, it can add no fact the facts don't carry. Posts
    // NOTHING and gates nothing.
    draftDeltaDigest: holdingContextFor(
      createLiveDeltaDigestPort({
        claudePort: claudeAdapterForRepo,
        codexExecutor: codexExecutorForRepo,
        writeContext: writeReviewContext,
        // The same root the writer wrote under, by construction: the context path the
        // prompt names is relative, so the turn's cwd and the write root are one value.
        turnRoot: turnRootFor,
      }),
    ),
    // The handoff-bundle composer (issue #72, M24): the light-tier authoring step over
    // the mechanical bundle. Council-routed over the SAME probes the refiner uses
    // (claude adapter + codex executor); one batched turn, exec-free (read-only). No
    // seat installed ⇒ the core router returns the mechanical floor.
    composeBundle: holdingContextFor(composeRoundBundle),
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
    // The benchmarks panel's read side (#731 9.6) — newest runs, capped by the caller.
    listBenchmarks: (limit) => benchmarkStore.read(limit),
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
      // …and which forge CLIs it has (C17 amendment B), so a WSL card shows its own state.
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

  // The cached half of the R19 projection context — the root table (perf audit §4 H3).
  // Rebuilt only when the granted-roots set grew or `projects.json` changed on disk.
  const projectionRootsContext = createCachedProjectionContext({
    listProjects: () => projectStore.list(),
    grantedRoots: allowedRoots,
    projectsPath: join(dataDir, "projects.json"),
    homeDir: homedir(),
  });

  // The loopback WS transport (#378). Started here — after dispatch exists — and
  // awaited so `createRennetServer` resolves only once the socket is `listening`,
  // so no `wsPort` is ever published before it accepts connections. (The desktop shell
  // no longer waits on any of this to show its window: it creates the window first and
  // asks MAIN for the port over IPC — perf audit §2/§6 H1.)
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
    // roots ∪ every stored project path. A new project is still referenceable at once
    // (the cache keys on `projects.json`'s own change stamp), but the rebuild no longer
    // runs per projected frame — which is per streamed ask token with a phone paired
    // (perf audit §4 H3). Loopback connections never consult it.
    projectionContext: () => ({
      ...projectionRootsContext(),
      // `reviewIsRunning` feeds the projected review's `attention.running` (#383 batch); the
      // listener adds `reviewNeedsYou` from its own attention registry when attention is on.
      // Live per call, over the cached root table.
      reviewIsRunning: (reviewId) => inFlightReviews.has(reviewId),
    }),
    // Opt-in bind beyond loopback (default stays 127.0.0.1:0).
    listen: daemonSettingsStore.read().daemon?.listen,
    // The served browser UI (#381); absent ⇒ headless.
    uiDist: options.uiDist,
    // The shutdown command (#820); absent ⇒ this server has no process to stop and 404s it.
    shutdown: options.onShutdownRequest
      ? { claimPath: daemonFilePath(dataDir), run: options.onShutdownRequest }
      : undefined,
  });

  void (async () => {
    // A captured review need not belong to a persisted Project. Rehydrate the exact roots owned
    // by durable rounds before recovery starts, just as repository.choose granted them before the
    // daemon stopped; otherwise recovery races review.load and fails before the renderer reconnects.
    for (const operation of roundOperationStore.listActive().operations) {
      allowedRoots.add(operation.repoRoot);
    }
    await coordinator.recover();
  })().catch((error) => {
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
    t3Sidecar.stopSync();
    for (const controller of sessionPreparations.values()) {
      controller.abort("Rennet is shutting down.");
    }
    sessionPreparations.clear();
    sessionPreparationRuns.clear();
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
