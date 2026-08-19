// @rennet/server composition root (#377). `createRennetServer` performs the
// composition the Electron main process used to do inline: it builds the stores,
// adapters, harness memoizers, and the dispatch command router, and returns a
// handle the shell drives in-process today and a transport serialises in phase 2.
// Electron-owned effects (data dir, dialog, progress broadcast, shell.openPath,
// net.fetch, process env) arrive as options; nothing here imports electron.
import { constants as fsConstants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/core";
import {
  applyVisibilitySwitch,
  beginUiEvidenceRun,
  bindUiEvidenceRun,
  CLAUDE_TESTED_RANGE,
  type ClaudeHarnessResult,
  CodexAdapter,
  type CodexAvailability,
  claudeHandoffRunPort,
  cleanupWorktree,
  completeUiEvidenceRun,
  createClaudeAdjudicationTurn,
  createClaudeCiRefinementTurn,
  createClaudeHarness,
  createCodexAdjudicationTurn,
  createCodexCiRefinementTurn,
  createCodexExecutor,
  createCodexTurnTransport,
  createCodexUtilityAdapter,
  createCoverageTurn,
  createGitHubOctokit,
  createGitHubProjectPrSource,
  createOmpTurnTransport,
  createRefPinner,
  createUiVerificationTurn,
  createVerificationFileReaderForPatchset,
  createVerificationTurn,
  defaultCodexDiscoveryDeps,
  defaultCodexExecEffects,
  defaultCodexTransportEffects,
  defaultDiscoveryDeps,
  defaultGlobalConfigPath,
  defaultOmpDiscoveryDeps,
  defaultProjectDetailSourceDeps,
  defaultProjectDiscoveryDeps,
  deriveCodexImplementedEvidence,
  deriveOmpImplementedEvidence,
  deriveProjectDraft,
  discoverClaude,
  discoverCodex,
  discoverOmp,
  discoverProject,
  discoverWorktreeIdentities,
  enrichKnowledgeForRepo,
  ensureProjectSnapshotPin,
  execaGitFor,
  executeExternalCommand,
  FileConfigStore,
  FileProjectStore,
  FileThreadStore,
  GitCaptureAdapter,
  GitCheckpointStore,
  GitHubChangesetSource,
  GitHubForgeAdapter,
  GitHubPrSubmissionAdapter,
  GitHubPublishAdapter,
  gitForRepoFactory,
  inspectUiEvidence,
  KnowledgeStore,
  loadConventionCatalogue,
  loadProjectDetail,
  NoveltyLifecycleRegistry,
  OmpAdapter,
  ProjectContextReader,
  type ProjectPrSource,
  ProjectSnapshotGenerator,
  parseGitHubPrRef,
  projectHypothesisRepoContext,
  RepoWatcher,
  readOpenSpecChange,
  readUiEvidence,
  refreshGitHubCredential,
  repoHasSubmodules,
  repoRecordOf,
  resolveBaseRef,
  resolveForgeRemote,
  resolveGitHubAuth,
  runGitHubDeviceFlow,
  runKnowledgeDeltaForRepo,
  SqliteReviewStore,
  snapshotStoreFor,
  validateGitHubToken,
  wslDiscoveryDeps,
} from "@rennet/adapters";
import {
  type AdmittedDocument,
  adjudicateFlaggedReview,
  attachRiskCrossCheck,
  buildOfferedManifest,
  buildReviewCanvases,
  type CodexExecutor,
  type CodexUtilityPort,
  classifyUiSurface,
  createHarnessRunTurn,
  createInvocationBudget,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  DEFAULT_REVIEW_INTELLIGENCE_BUDGET,
  decompose,
  detectLocus,
  escapePath,
  type FanInIndex,
  type ForgePrSubmission,
  type ForgePrSubmissionOutcome,
  fanInIndexFromSnapshot,
  guardSeatTurn,
  type HarnessPort,
  type HarnessTurnResult,
  HOST_LOCUS,
  type Locus,
  LocusDistroMismatchError,
  LocusPathUntranslatableError,
  patchsetIntentToReviewIntent,
  ReviewService,
  recordSeatSend,
  resolveAssignment,
  resolveDualSeat,
  resolveLocus,
  runCoverageMapping,
  runDecisionAngle,
  runDualFindingReview,
  runHandoffTurn as runHandoffTurnCore,
  runHypothesisPass,
  runNoiseAngle,
  runUiVerification,
  toDistroPath,
  toWindowsView,
  verifyFlaggedReview,
} from "@rennet/core";
import type {
  DetectedHarness,
  GitHubAuthStatus,
  GitHubConnectPoll,
  ProjectProcessEvent,
} from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  ContextManifest,
  ConventionCatalogue,
  CouncilHarnessId,
  DecisionsRunStatus,
  ElementDiffs,
  FlaggedReview,
  HypothesisStructure,
  InvocationBudget,
  NoiseReview,
  OpenSpecCoverage,
  OwnershipRule,
  Patchset,
  Review,
  ReviewEngine,
  ReviewHypothesis,
  ReviewNarration,
} from "@rennet/types";
import { attachCiSignal } from "./ci-signal";
import { createLiveDeltaDigestPort } from "./delta-digest-live";
import { createDispatch, type FlaggedReviewRun } from "./dispatch";
import { createLiveDraftPrBodyPort } from "./draft-pr-body-live";
import { stampBlockingStates } from "./flagged-blocking-states";
import { composeFlaggedLateEnrichment } from "./flagged-late-enrichment";
import { projectUnavailableDeepVerification } from "./flagged-review-verification";
import { applyImmediateUiVerification } from "./flagged-ui-verification";
import { createGitHubTokenStore } from "./github-token-store";
import { createLiveComposeBundle } from "./handoff-compose-live";
import { InFlightReviews } from "./in-flight-reviews";
import { createDesktopReviewBackend, createDesktopReviewContextFeed } from "./live-review-backend";
import { LiveTurnRegistry } from "./live-turn-registry";
import {
  createEditorLaunchEffects,
  editorLaunchSpec,
  performOpenInEditor,
  resolveEditorExecutables,
} from "./open-in-editor";
import { createOrchestratorTurnRunner, resolveOrchestratorHarnessSelection } from "./orchestrator";
import { PairingStore } from "./pairing-store";
import {
  createProactiveRehydration,
  PROACTIVE_REHYDRATION_COMMAND_ID,
  type ProactiveRehydration,
} from "./proactive-rehydration";
import { createProcessProject } from "./process-project";
import { buildProjectionContext } from "./projection";
import { createPublishConsentAuthority } from "./publish-consent-authority";
import { PushTokenStore } from "./push-token-store";
import { createLiveRefinePort } from "./refine-comment-live";
import { CODEX_ASK_LABEL, createLiveCodexAsk, createLiveReviewAskPorts } from "./review-ask-live";
import { type ReviewContextFeed, runWithReviewContextFeed } from "./review-context-feed";
import type { ReviewIntelligenceSession } from "./review-intelligence-session";
import { loadReviewOwnership } from "./review-ownership";
import { buildReviewCanvasesInput } from "./review-pipeline-input";
import { createSettingsComposition } from "./settings";
import { createLiveSymbolLookup, reviewPinnedToHead } from "./symbol-lookup-live";
import { startWsListener, type WsListener } from "./ws-listener";

export interface RennetServerOptions {
  /** The per-user data directory (Electron passes app.getPath("userData")); every store resolves under it. */
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
  /** The server application's own version, surfaced in the WS `serverInfo` handshake. Defaults to a dev sentinel. */
  readonly serverVersion?: string;
  /**
   * Directory of a built browser UI to serve over the HTTP port (issue #381). Absent ⇒
   * the daemon runs headless. Passed straight to the WS listener's static handler.
   */
  readonly uiDist?: string;
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
}

export async function createRennetServer(options: RennetServerOptions): Promise<RennetServer> {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir;

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
  const liveSnapshotStore = snapshotStoreFor();
  const liveNoveltyLifecycle = new NoveltyLifecycleRegistry();

  /**
   * The effective execution locus for a repo path (add-windows-support): the persisted
   * per-project override if set, else auto-detected from the path (a `\\wsl$` root ⇒
   * that distro, else host). Every repo-facing spawn in this composition routes
   * through it, so a WSL-locus project's git/harness run inside the distro (Rule Zero:
   * a plain resolution, never a gate). The store keys on the realpath-canonical top
   * level, matching how settings resolves the same identity.
   */
  function locusForRepo(repoRoot: string): Locus {
    let key: string;
    try {
      key = escapePath(realpathSync(repoRoot));
    } catch {
      key = escapePath(repoRoot);
    }
    return resolveLocus(detectLocus(repoRoot), liveSnapshotStore.loadConfig(key)?.locus).value;
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
    readonly port: CodexUtilityPort | null;
    readonly executor: CodexExecutor | null;
    readonly agenticPort:
      | ((mcpServers: Readonly<Record<string, { readonly url: string }>>) => HarnessPort)
      | null;
    /** The resolved absolute `codex` path (for the ask-AI executor), or null. */
    readonly binPath: string | null;
    /** The resolved codex version, stamped as harness provenance, or null. */
    readonly version: string | null;
  }
  // Memoized PER LOCUS (add-windows-support / #334), like the Claude harness: the host
  // resolution is shared as before; a WSL-locus project discovers and runs the DISTRO's
  // own `codex` (distro discovery deps, locus-wrapped executor + transport, distro-side
  // scratch). The utility executor and agentic transport carry the locus so every spawn
  // enters the distro through `locusCommand` — a WSL review is dual-harness rather than
  // degrading to single-Claude.
  const codexResolutions = new Map<string, Promise<CodexResolution>>();
  function getCodexResolution(locus: Locus): Promise<CodexResolution> {
    const key = locus.kind === "wsl" ? `wsl:${locus.distro}` : "host";
    let resolution = codexResolutions.get(key);
    if (!resolution) {
      resolution = (async (): Promise<CodexResolution> => {
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
            port: null,
            executor: null,
            agenticPort: null,
            binPath: null,
            version: null,
          };
        }
        const executor = createCodexExecutor(defaultCodexExecEffects, {
          bin: chosen.path,
          harnessVersion: chosen.version,
          ...(chosen.runtimePath === undefined ? {} : { runtimePath: chosen.runtimePath }),
          ...(locus.kind === "wsl" ? { locus } : {}),
        });
        const transport = createCodexTurnTransport(
          chosen.path,
          defaultCodexTransportEffects,
          locus,
          chosen.runtimePath,
        );
        const capabilityEvidence = await deriveCodexImplementedEvidence(chosen.path);
        return {
          availability: { available: true, version: chosen.version },
          port: createCodexUtilityAdapter({ executor }),
          executor,
          agenticPort: (mcpServers) =>
            new CodexAdapter({
              binaryPath: chosen.path,
              transport,
              version: chosen.version,
              ...(capabilityEvidence === undefined ? {} : { capabilityEvidence }),
              mcpServers,
            }),
          binPath: chosen.path,
          version: chosen.version,
        };
      })();
      codexResolutions.set(key, resolution);
    }
    return resolution;
  }

  function getCodexAvailability(): Promise<CodexAvailability> {
    return getCodexResolution(HOST_LOCUS).then((resolution) => resolution.availability);
  }

  // The locus-aware seat probes the live producers (refine, draft-PR-body, delta digest,
  // compose) are bound to (#334). Each resolves the review's locus, so a WSL project's
  // light-tier turn runs the distro's claude/codex — not the host's.
  async function claudeAdapterForRepo(repoRoot: string): Promise<HarnessPort | null> {
    const { locus, distroCwd } = locusContextForRepo(repoRoot);
    return (await getClaudeHarness(locus, distroCwd)).adapter ?? null;
  }
  async function codexExecutorForRepo(repoRoot: string): Promise<CodexExecutor | null> {
    const { locus } = locusContextForRepo(repoRoot);
    return (await getCodexResolution(locus)).executor;
  }

  // ── The omp resolution (#26) ───────────────────────────────────────────────────
  // omp is the THIRD harness slot (R23). It serves the orchestrator seat ONLY when
  // neither Claude nor Codex is installed (see `resolveHarness`) — the deliberately
  // minimal selection policy. Resolution mirrors the Codex one exactly: discover an
  // `omp` binary AND a runnable Bun (a missing Bun is honest DEGRADED health that names
  // the runtime, never a crash), derive the hermetic conformance evidence once, and
  // expose an `agenticPort(mcpServers)` factory that builds an `OmpAdapter` wired to the
  // REAL `omp --mode rpc` transport with the loopback canvasOps@2 URL — the same
  // external-MCP contract Codex uses, no harness conditional in the canvasOps layer.
  // Composed LAZILY and memoized so the login-shell + probe work runs on first use.
  interface OmpResolution {
    readonly agenticPort:
      | ((mcpServers: Readonly<Record<string, { readonly url: string }>>) => HarnessPort)
      | null;
    readonly version: string | null;
  }
  let ompResolution: Promise<OmpResolution> | null = null;
  function getOmpResolution(): Promise<OmpResolution> {
    ompResolution ??= (async (): Promise<OmpResolution> => {
      const explicitBin = env.RENNET_OMP_BIN;
      const result = await discoverOmp(defaultOmpDiscoveryDeps(), {
        ...(explicitBin && explicitBin.length > 0 ? { explicitBin } : {}),
      });
      const chosen = result.chosen;
      if (!chosen?.runtimePath) {
        // omp missing, or omp present but Bun absent — the Bun-aware health already
        // carries the reason. No orchestrator seat against the slot.
        return { agenticPort: null, version: null };
      }
      const transport = createOmpTurnTransport(chosen.path, chosen.runtimePath);
      const capabilityEvidence = await deriveOmpImplementedEvidence(chosen.path);
      return {
        agenticPort: (mcpServers) =>
          new OmpAdapter({
            binaryPath: chosen.path,
            transport,
            version: chosen.version,
            ...(capabilityEvidence === undefined ? {} : { capabilityEvidence }),
            mcpServers,
          }),
        version: chosen.version,
      };
    })();
    return ompResolution;
  }

  // The ambient first-run detection line (issue #29): which harnesses are on the
  // machine. Read-only, no repository, no model call — it is DISCLOSURE, felt not
  // ceremonial. Memoized like the harness/codex probes: the claude probe spawns the
  // login shell, so it runs once on the first front-door mount, not at launch. A
  // probe that finds nothing simply drops that harness; the line degrades to
  // whatever was found (or nothing), never an error.
  let harnessDetection: Promise<DetectedHarness[]> | null = null;
  // gh is GONE from the detection line (v4.2): GitHub is an account (the device
  // sign-in), not a CLI to detect. The line covers harnesses only.
  function detectHarnesses(): Promise<DetectedHarness[]> {
    harnessDetection ??= (async (): Promise<DetectedHarness[]> => {
      const [claude, codex] = await Promise.all([
        discoverClaude(defaultDiscoveryDeps(), CLAUDE_TESTED_RANGE).catch(() => null),
        getCodexAvailability().catch(() => null),
      ]);
      const detected: DetectedHarness[] = [];
      if (claude?.chosen) detected.push({ id: "claude", version: claude.chosen.version });
      if (codex?.available) detected.push({ id: "codex", version: codex.version ?? null });
      return detected;
    })();
    return harnessDetection;
  }

  // ── The GitHub egress composition (issue #21, v4.2 device flow) ──────────────
  // The outbound HTTP is injected by the shell (the app owns the transport), so no
  // code here holds a raw socket. The bearer is the STORED token — minted by the
  // OAuth device flow or pasted as a PAT, kept in the daemon's 0600 token file —
  // resolved LAZILY on the FIRST real egress, never at launch and never for a
  // dry-run (which constructs the request without a credential).
  const publishHttp: typeof globalThis.fetch =
    options.httpFetch ??
    (() => Promise.reject(new Error("Rennet server: options.httpFetch was not provided")));

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
    authUnavailable?: "not-connected" | "token-invalid" | "insufficient-scope";
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
          // A transport blip (refresh POST, /rate_limit) must degrade to the
          // local-only list, never fail the whole project.detail RPC. No
          // authUnavailable hint: "reconnect" would be the WRONG advice for a
          // network problem. The memo is cleared so the next call retries.
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
      return await memo.promise;
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
            flow.outcome = { phase: "failed", message: String((error as Error)?.message ?? error) };
            rejectVerification(error);
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

  let repositoryDirty = false;
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
   * The GitHub PR front door (issue #37/#20 flow, User Journey stage 2). Parse the
   * ref, deep-fetch the PR (GitHub owns identity), pin its OIDs in the local clone
   * at `repoPath`, diff the range locally (git owns content), and persist a review.
   * The token is resolved lazily from the auth ladder (`gh auth token`) — the
   * zero-config North Star, the user's own `gh`. A PR whose clone is not at the
   * chosen folder yields a null pin (only the degraded REST diff is available); this
   * slice does not open the REST path yet, so it asks for the right local clone.
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
    repoPath: string,
    retrospective: boolean,
  ): Promise<Review> {
    const prRef = parseGitHubPrRef(ref);
    if (!prRef) {
      throw new Error(`"${ref}" is not a pull request. Use owner/repo#123 or a GitHub PR URL.`);
    }
    const forge = new GitHubForgeAdapter({ octokit: await resolveGitHubOctokit() });
    const gitInLocus = gitForRepo(repoPath);
    const source = new GitHubChangesetSource({
      forge,
      git: gitInLocus,
      pin: createRefPinner(gitInLocus),
      // The candidate set is the single local clone the user picked. Identity
      // matching (owner/name vs the repo's remotes) decides whether it is the
      // right clone; it never falls back to a path-name guess.
      worktrees: { list: async () => [await discoverWorktreeIdentities(gitInLocus, repoPath)] },
      resolveProjectSnapshotId: (root, baseOid) =>
        ensureProjectSnapshotPin(liveSnapshotStore, root, baseOid, gitInLocus),
    });
    const result = await source.open(prRef);
    if (!result.pin) {
      throw new Error(
        `The folder you chose is not a local clone of ${prRef.repo.owner}/${prRef.repo.name}. ` +
          "Open this PR from a local clone of that repository (REST-only review is not available yet).",
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
        };
    return service.createReviewFromPatchset(commandId, result.patchset, {
      retrospective,
      ...(postTarget ? { postTarget } : {}),
    });
  }

  /**
   * The harness-backed live pipeline: decompose the review's active patchset,
   * gate on the Brita budget, and (when the user's `claude` is discoverable) drive
   * the decomposition angle + ordering pass on their subscription OAuth. With no
   * harness the deterministic floor still populates real canvases from the diff.
   */
  async function buildCanvasesForReviewWithContextFeed(
    review: Review,
    contextFeed: ReviewContextFeed,
    session: ReviewIntelligenceSession,
  ): Promise<{
    canvases: Record<CanvasAngle, Canvas>;
    elementDiffs: ElementDiffs;
    narration?: ReviewNarration;
    engine: ReviewEngine;
    /** How the Decisions lens's producer ran (issue #137): discerned vs failed. */
    decisionsRun: DecisionsRunStatus;
    /** The committed hypothesis (#178), when one was produced; the human's reading frame. */
    hypothesis?: ReviewHypothesis;
    /** The captured context-composition manifest; absent ⇒ honestly not available. */
    contextManifest?: ContextManifest;
  }> {
    const patchset = activePatchset(review);
    const { locus, distroCwd } = locusContextForRepo(review.repositoryRoot);
    const { adapter } = await getClaudeHarness(locus, distroCwd);
    const codexResolution = await getCodexResolution(locus);
    const codex = codexResolution.availability;
    const codexPort = codexResolution.port;
    // KNOWN §7 DEVIATION (documented in the openspec change's design.md): the
    // read-only harness runs with `cwd` on the live mutable checkout rather than
    // an immutable materialisation, because that layer is not built yet and the
    // "Claude CLI isolation" evidence gate is openly Blocked. Follow-up: materialise
    // the active patchset to an app-owned cache and point `cwd` there. Do NOT read
    // this as a satisfied contract.
    const runDecompositionTurn = adapter
      ? createHarnessRunTurn(adapter, {
          docType: "decomposition.proposal",
          cwd: review.repositoryRoot,
        })
      : undefined;
    const runOrderingTurn = adapter
      ? createHarnessRunTurn(adapter, { docType: "ordering", cwd: review.repositoryRoot })
      : undefined;
    // Roll-up narration (#70) is a light-tier council-routed seat. Under `both` the
    // council routes it to cheap Codex ($0) via the port; under claude-only it uses
    // this injected Claude turn. Absent an adapter it stays pending (never faked).
    const runNarrationTurn = adapter
      ? createHarnessRunTurn(adapter, { docType: "rollup-narration", cwd: review.repositoryRoot })
      : undefined;

    // The Model Council availability is the honestly-probed installed set: Claude
    // iff its binary was discovered, Codex iff `codex --version` answered. The
    // Codex port is passed IFF codex is installed — so a Codex resolution is always
    // executable (the invariant the pipeline's fail-closed floor relies on).
    const installed: CouncilHarnessId[] = [];
    if (adapter) installed.push("claude-code");
    if (codex.available) installed.push("codex");

    // The Decisions lens (issue #137): the LIVE decision-extraction runner replaces
    // `decisionsRecordFixture()` behind the unchanged `decisionDocs` boundary. It
    // reasons over {the offered hunks + the change's stated intent} and emits real
    // `decision.record` docs the existing projector groups by theme. On a runner
    // failure it yields an empty doc set + a LOUD `failed` status, kept strictly
    // apart from "ran, nothing discerned" (an ok run with no decisions).
    // ① The hypothesis-first pre-read pass (#178): produce the committed prior ONCE
    // per review — BEFORE the lens producers reason over hunks — from the change's
    // structure (deterministic decomposition chunk titles + changed files). Live
    // intent capture (#136) and the ProjectSnapshot context feed are deferred seams,
    // so the pass degrades honestly (structure-only) today, exactly as the decision
    // runner reasons over the diff alone until #136. Its committed hypothesis feeds
    // the Decisions runner as disconfirmation criteria and rides the result as the
    // human's reading frame. Absent an adapter (or on a failed pass) it is undefined
    // and every lens runs exactly as before. It is drawn from the per-review
    // intelligence session (#316): the canvas and flagged flows share ONE hypothesis
    // and ONE ceiling for the current review turn, so the turn spends the hypothesis
    // once, not once per flow. Re-entry starts a fresh session even at the same key.
    const hypothesis = await session.hypothesis((budget) =>
      computeReviewHypothesis(review, patchset, adapter, contextFeed, budget),
    );

    // The per-project convention checklist (#180), sourced once and fed to the
    // Decisions runner as a labelled layer. Absent (no catalogue file), the runner
    // reasons exactly as before.
    const conventions = loadReviewConventions(review);

    const decisions = await runDecisionsForReview(
      review,
      patchset,
      adapter,
      contextFeed,
      session.budget,
      hypothesis,
      conventions,
    );

    // The blast-radius CODEOWNERS-overlap signal (issue #35) fires only when handed
    // the review's ownership rules. Read them off the built ProjectSnapshot; absent a
    // snapshot they are `[]` and the signal degrades honestly (never fires).
    const ownership = await loadReviewOwnershipRules(review);
    // The fan-in index (#200), materialized off the built snapshot; undefined ⇒ fan-in
    // stays NOT-ASSESSED (the populated guard lives in the loader), never a silent zero.
    const fanIn = await loadReviewFanInIndex(review);
    // Assemble the pipeline input at the ONE testable composition seam (F4): this is
    // where `ownership` reaches the pipeline, so the guard against dropping it lives on
    // `buildReviewCanvasesInput`, not on the loader beneath it. The Decisions lens
    // (issue #137) rides `decisionDocs`: real `decision.record` docs placed by the
    // existing projector; the runner reasons over the diff alone until #136 intent
    // capture lands (it fully supports intent, proven by the live {diff, PR body} dogfood).
    const result = await buildReviewCanvases(
      buildReviewCanvasesInput({
        reviewId: review.id,
        patchset,
        dispositions: review.dispositions,
        ownership,
        ...(fanIn ? { fanIn } : {}),
        installed,
        decisionDocs: decisions.docs,
        budget: session.budget,
        ...(codexPort ? { codexPort } : {}),
        ...(runDecompositionTurn ? { runDecompositionTurn } : {}),
        ...(runOrderingTurn ? { runOrderingTurn } : {}),
        ...(runNarrationTurn ? { runNarrationTurn } : {}),
        ...(contextFeed.assembledContext === undefined
          ? {}
          : { assembledContext: contextFeed.assembledContext }),
        onSend: contextFeed.onSend,
      }),
    );
    // The honesty signal for the renderer (real-AI-default): a review is a REAL AI
    // review iff at least one model harness was installed AND the budget actually
    // let a turn run. With neither claude nor codex — or a refused budget — the set
    // is the deterministic mechanical outline of the diff, and the UI must say so.
    const engine: ReviewEngine = {
      claudeAvailable: adapter !== undefined,
      codexAvailable: codex.available,
      aiReview: installed.length > 0 && !result.budgetRefused,
    };
    return {
      canvases: result.canvases,
      elementDiffs: result.elementDiffs,
      narration: result.narration,
      engine,
      decisionsRun: decisions.status,
      ...(hypothesis ? { hypothesis } : {}),
    };
  }

  async function buildCanvasesForReview(
    review: Review,
    _deepReview: boolean,
    session: ReviewIntelligenceSession,
  ): ReturnType<typeof buildCanvasesForReviewWithContextFeed> {
    const contextFeed = await createDesktopReviewContextFeed(review, {
      onError: reportContextFeedError,
    });
    const completed = await runWithReviewContextFeed(contextFeed, () =>
      buildCanvasesForReviewWithContextFeed(review, contextFeed, session),
    );
    return {
      ...completed.result,
      ...(completed.contextManifest ? { contextManifest: completed.contextManifest } : {}),
    };
  }

  // The provenance seed for a live hypothesis pass (issue #178), mirroring the
  // finding/decision seeds. Provenance is stamped on the RSP document but not read
  // by the reading-frame derivation (which consumes the extracted hypothesis body),
  // so a placeholder model is honest for placement; the capability layers are true
  // because this path DOES constrain structured output through the adapter.
  const HYPOTHESIS_PROVENANCE_SEED = {
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

  /**
   * The CODEOWNERS rules for a review (issue #35, F4), read off its built
   * ProjectSnapshot so the blast-radius CODEOWNERS-overlap signal can actually fire
   * in the real app. Honest degradation: no built snapshot (or an unresolvable repo)
   * ⇒ `[]`, so the overlap signal simply does not fire — never a false single-owner
   * claim. `resolveBaseRef` throws when it cannot pin a default branch; that is
   * caught to a null key rather than crashing the canvas build.
   */
  function loadReviewOwnershipRules(review: Review): Promise<readonly OwnershipRule[]> {
    return loadReviewOwnership(
      {
        loadManifest: (repoKey) => snapshotStoreFor().loadManifest(repoKey),
        loadShard: (repoKey, digest) => snapshotStoreFor().loadShard(repoKey, digest),
        resolveRepoKey: async (repositoryRoot) => {
          try {
            return (await resolveBaseRef(repositoryRoot, { git: gitForRepo(repositoryRoot) }))
              .repoKey;
          } catch (error) {
            if (error instanceof LocusDistroMismatchError) throw error;
            return null;
          }
        },
      },
      review,
    );
  }

  /**
   * The fan-in index for a review (#200 → #35 follow-on), materialized off its built
   * ProjectSnapshot so the blast-radius fan-in signal is ASSESSED in the real app — the
   * "read beyond the diff" the dogfood flagged Rennet cannot do.
   *
   * ⭐ The POPULATED GUARD is the load-bearing part: fan-in is supplied ONLY when the
   * manifest actually carries reference shards. No repo key, no snapshot, a stale/absent
   * snapshot, or an EMPTY reference index ⇒ `undefined`, and fan-in stays a NOT-ASSESSED
   * chip — never a silent zero that would read as "checked, nothing depends on anything".
   */
  async function loadReviewFanInIndex(review: Review): Promise<FanInIndex | undefined> {
    const root = review.repositoryRoot;
    if (!root) return undefined;
    let repoKey: string | null;
    try {
      repoKey = (await resolveBaseRef(root, { git: gitForRepo(root) })).repoKey;
    } catch (error) {
      if (error instanceof LocusDistroMismatchError) throw error;
      return undefined;
    }
    if (!repoKey) return undefined;
    const store = snapshotStoreFor();
    const manifest = store.loadManifest(repoKey);
    // Only assess fan-in when the reference index is genuinely POPULATED (#200).
    if (!manifest || manifest.references.length === 0) return undefined;
    const gated = new ProjectContextReader(store).loadFresh(repoKey, manifest.baseOid);
    if (!gated.ok) return undefined;
    return fanInIndexFromSnapshot(gated.snapshot);
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
   * Produce the committed hypothesis for a review (issue #178), once, before the
   * lens producers run. It decomposes the active patchset for identity + structure
   * (the chunk titles + changed-file list — NOT the hunk bodies, so the prior is
   * genuine), runs the hypothesis pass on the user's `claude` (subscription OAuth),
   * budget-gated as its own live action, and returns the extracted hypothesis or
   * `undefined` when the pass could not complete. The change's stated intent (#136)
   * is now projected from the frozen capture on the patchset and fed in; the
   * ProjectSnapshot context feed remains a deferred seam. When no intent surface was
   * captured (a no-PR working-tree review that touched no spec), the pass degrades
   * honestly to a structure-only prior. A failed pass is never surfaced as an empty
   * hypothesis — the review simply proceeds with no reading frame.
   */
  async function computeReviewHypothesis(
    review: Review,
    patchset: Patchset,
    adapter: Awaited<ReturnType<typeof getClaudeHarness>>["adapter"],
    contextFeed: ReviewContextFeed,
    budget: InvocationBudget,
  ): Promise<ReviewHypothesis | undefined> {
    if (!adapter) return undefined;
    const decomposition = decompose(patchset);
    const manifest = buildOfferedManifest(decomposition);
    const structure: HypothesisStructure = {
      changedFiles: patchset.files.map((file) => file.path),
      chunkTitles: decomposition.chunks.map((chunk) => chunk.title),
    };
    // KNOWN §7 DEVIATION (as elsewhere): the read-only harness runs with `cwd` on the
    // live mutable checkout rather than an immutable materialisation. Do NOT read as
    // satisfied.
    const runHypothesisTurn = createHarnessRunTurn(adapter, {
      docType: "review.hypothesis",
      cwd: review.repositoryRoot,
    });
    // The change's stated intent (#136), projected from the frozen capture on the
    // patchset. Absent (a no-PR working-tree review with no spec touched) it is
    // undefined and the pass runs on structure + repo context alone — the honest
    // degrade, unchanged from before intent capture landed.
    const intent = patchsetIntentToReviewIntent(patchset.intent);
    const repoContext = projectHypothesisRepoContext(
      new ProjectContextReader(snapshotStoreFor()),
      repoRecordOf(review),
      patchset.files.map((file) => file.path),
    );
    const result = await runHypothesisPass({
      patchsetId: patchset.id,
      manifest,
      structure,
      ...(intent ? { intent } : {}),
      ...(repoContext ? { repoContext } : {}),
      provenance: HYPOTHESIS_PROVENANCE_SEED,
      // A thrown/rejected turn (a session/transport construction exception, #96)
      // degrades to a turn-failure rather than crashing the command.
      runTurn: recordedDesktopSeatTurn(runHypothesisTurn, "hypothesis", contextFeed),
      budget,
      maxRetries: 0,
      ...(contextFeed.assembledContext === undefined
        ? {}
        : { assembledContext: contextFeed.assembledContext }),
    });
    return result.status === "ok" ? result.hypothesis : undefined;
  }

  // The provenance seed for a live decision run (issue #137), mirroring the finding
  // seed. Provenance is stamped on the RSP document but not read by the decisions
  // projector (which consumes docId/docType/body), so a placeholder model is honest
  // for placement; the capability layers are true because this path DOES constrain
  // structured output through the adapter.
  const DECISION_PROVENANCE_SEED = {
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
   * The live Decisions lens producer (issue #137), replacing `decisionsRecordFixture`.
   * Decomposes the review's active patchset into the offered hunk manifest and runs
   * the decision angle on the user's `claude` (subscription OAuth), budget-gated by
   * the same review-turn budget as the hypothesis and canvas model phase. On `ok`
   * its emitted `decision.record` document is returned as the
   * `decisionDocs` the projector groups; on a runner failure/budget refusal the doc
   * set is empty and the status is the LOUD `failed` state — "ran, nothing discerned"
   * (an ok run with an empty set) is never faked from "did not run".
   *
   * The change's stated intent (PR title/body + spec) is captured with the patchset
   * (#136) and projected onto the runner's intent seam here, so the runner reasons
   * over {diff, intent}. When no intent surface was captured it degrades to the diff
   * alone — the honest fallback, unchanged from before capture landed.
   */
  async function runDecisionsForReview(
    review: Review,
    patchset: Patchset,
    adapter: Awaited<ReturnType<typeof getClaudeHarness>>["adapter"],
    contextFeed: ReviewContextFeed,
    budget: InvocationBudget,
    hypothesis?: ReviewHypothesis,
    conventions?: ConventionCatalogue,
  ): Promise<{ docs: AdmittedDocument[]; status: DecisionsRunStatus }> {
    if (!adapter) {
      return {
        docs: [],
        status: { status: "failed", reason: "no model harness is available to discern decisions" },
      };
    }
    const decomposition = decompose(patchset);
    const manifest = buildOfferedManifest(decomposition);
    // KNOWN §7 DEVIATION (as in buildCanvasesForReview): the read-only harness runs
    // with `cwd` on the live mutable checkout rather than an immutable materialisation,
    // because that layer is not built yet. Follow-up: materialise the active patchset
    // to an app-owned cache and point `cwd` there. Do NOT read this as satisfied.
    const runDecisionTurn = createHarnessRunTurn(adapter, {
      docType: "decision.record",
      cwd: review.repositoryRoot,
    });
    // The change's stated intent (#136), projected from the frozen capture on the
    // patchset (PR title/body + the spec set). Absent, the runner reasons over the
    // diff alone — the honest degrade. `DecisionIntent` is structurally identical to
    // the mapped `ReviewIntent`, so the same projection feeds both runners.
    const intent = patchsetIntentToReviewIntent(patchset.intent);
    const result = await runDecisionAngle({
      patchsetId: patchset.id,
      manifest,
      ...(intent ? { intent } : {}),
      // The committed hypothesis (#178), when produced, feeds the runner as
      // disconfirmation criteria — so a decision can surface where the change diverges
      // from what we'd have chosen. Absent, the runner reasons exactly as before.
      ...(hypothesis ? { hypothesis } : {}),
      // The per-project convention catalogue (#180), when sourced, feeds the runner
      // as a checklist layer — a decision can surface where the change diverges from
      // an established convention, reporting the reason (never a rule number).
      ...(conventions ? { conventions } : {}),
      provenance: DECISION_PROVENANCE_SEED,
      // A thrown/rejected turn (a session/transport construction exception, #96)
      // degrades to a turn-failure rather than crashing the command.
      runTurn: recordedDesktopSeatTurn(runDecisionTurn, "decisions", contextFeed),
      budget,
      ...(contextFeed.assembledContext === undefined
        ? {}
        : { assembledContext: contextFeed.assembledContext }),
    });
    if (result.status === "ok") {
      const doc = result.document;
      const docs: AdmittedDocument[] =
        doc && doc.docId !== undefined
          ? [{ docId: doc.docId, docType: doc.docType, body: doc.body }]
          : [];
      return { docs, status: { status: "ok" } };
    }
    return {
      docs: [],
      status: {
        status: "failed",
        reason: result.failureReason ?? "the decision runner did not complete",
      },
    };
  }

  // The provenance seed for a live finding run. Provenance is stamped on the RSP
  // document but not read by the Flagged lens (findings map straight to the lens),
  // so a placeholder model is honest for placement; the capability layers are set
  // true because this path DOES constrain structured output through the adapter.
  const FINDING_PROVENANCE_SEED = {
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
    contextFeed: ReviewContextFeed,
    session: ReviewIntelligenceSession,
  ): Promise<FlaggedReviewRun> {
    const patchset = activePatchset(review);
    const { locus, distroCwd } = locusContextForRepo(review.repositoryRoot);
    const { adapter } = await getClaudeHarness(locus, distroCwd);
    const sharedBudget = session.budget;
    const codexResolution = await getCodexResolution(locus);
    const codex = codexResolution.availability;
    const codexPort = codexResolution.port;
    const decomposition = decompose(patchset);
    const manifest = buildOfferedManifest(decomposition);
    // KNOWN §7 DEVIATION (as in buildCanvasesForReview): the read-only harness runs
    // with `cwd` on the live mutable checkout rather than an immutable materialisation,
    // because that layer is not built yet. Follow-up: materialise the active patchset
    // to an app-owned cache and point `cwd` there. Do NOT read this as satisfied.
    const claudeTurn = adapter
      ? createHarnessRunTurn(adapter, { docType: "finding", cwd: review.repositoryRoot })
      : undefined;

    // The honestly-probed installed set: the Codex port is passed IFF codex is
    // installed, so a Codex seat is always executable (the resolver's invariant).
    const installed: CouncilHarnessId[] = [];
    if (adapter) installed.push("claude-code");
    if (codex.available) installed.push("codex");

    const ciAssignment = resolveAssignment("ci-failure-classification", {
      availability: { installed },
    });
    const ciRefinementTurn =
      ciAssignment.kind !== "model"
        ? undefined
        : ciAssignment.harness === "codex" && codexResolution.executor
          ? createCodexCiRefinementTurn(codexResolution.executor, {
              model: ciAssignment.model,
              effort: ciAssignment.effort,
            })
          : ciAssignment.harness === "claude-code" && adapter
            ? createClaudeCiRefinementTurn(adapter, {
                cwd: review.repositoryRoot,
                model: ciAssignment.model,
              })
            : undefined;

    // The ordered dual seats (Claude first, Codex second), each with its honest
    // provenance seed and executor. Under a single provider this is one seat.
    const seats = resolveDualSeat({
      council: { availability: { installed } },
      jobId: "finding-generation",
      docType: "finding",
      patchsetId: patchset.id,
      manifest,
      baseSeed: FINDING_PROVENANCE_SEED,
      ...(claudeTurn ? { claudeTurn } : {}),
      ...(codexPort ? { codexPort } : {}),
    });

    // Hypothesis, both finding seats, and verification draw from ONE review budget:
    // the ceiling stops spend, never the review. The dual runner guards each seat's
    // turn (a thrown Codex spawn degrades to a failed seat, then the reconcile
    // degrades) and owns the reconcile + the honest single-provider degradation.
    // The per-project convention checklist (#180), fed to BOTH seats as a labelled
    // layer. Absent (no catalogue file), each seat assembles exactly as before.
    const conventions = loadReviewConventions(review);

    // The committed hypothesis (#178) and the change's stated intent (#136), fed to
    // BOTH finding seats so the Flagged lens reasons over the same disconfirmation
    // prior + PR intent the Decisions runner already gets (issue #210) — the whole
    // point of hypothesis-first is that it shapes EVERY finding, not just decisions.
    // The hypothesis is produced ONCE per review turn by the intelligence session
    // (#316) and shared with the canvas flow — never recomputed here (from the
    // change's structure + intent + repo context, never the hunk bodies, so the prior
    // stays genuine); absent an adapter or on a failed pass it is undefined. The intent
    // is projected from the frozen capture on the patchset; absent a captured surface
    // it is undefined. With BOTH undefined the finding assembly is byte-identical to
    // before this change (no regression).
    const hypothesis = await session.hypothesis((budget) =>
      computeReviewHypothesis(review, patchset, adapter, contextFeed, budget),
    );
    const intent = patchsetIntentToReviewIntent(patchset.intent);

    const { review: flagged } = await runDualFindingReview({
      deepReview,
      patchsetId: patchset.id,
      manifest,
      seats,
      budget: sharedBudget,
      ...(intent ? { intent } : {}),
      ...(hypothesis ? { hypothesis } : {}),
      ...(conventions ? { conventions } : {}),
      ...(contextFeed.assembledContext === undefined
        ? {}
        : { assembledContext: contextFeed.assembledContext }),
      onSend: contextFeed.onSend,
    });

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
    let adjudicationOptions: Parameters<typeof adjudicateFlaggedReview>[1] | undefined;
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
      // Cross-harness adjudication (#41): AFTER verification, on the surviving rows
      // (a refuted row is already dropped). When the two seats DISAGREED, one fresh
      // turn per contested row on the seat the council resolves for the `adjudication`
      // job asks the real code who is right — a genuine third opinion, drawn from the
      // SAME shared review budget. The verdict rides the disagree arm; it never drops,
      // hides, or gates a row (Rule Zero). Absent an executor for the resolved harness,
      // rows surface unadjudicated (honest degradation).
      const adjResolution = resolveAssignment("adjudication", { availability: { installed } });
      const adjudicationTurn =
        adjResolution.kind !== "model"
          ? undefined
          : adjResolution.harness === "codex" && codexResolution.executor
            ? createCodexAdjudicationTurn(codexResolution.executor, {
                model: adjResolution.model,
                effort: adjResolution.effort,
              })
            : adjResolution.harness === "claude-code" && adapter
              ? createClaudeAdjudicationTurn(adapter, {
                  cwd: review.repositoryRoot,
                  model: adjResolution.model,
                })
              : undefined;
      if (adjResolution.kind === "model" && adjudicationTurn) {
        adjudicationOptions = {
          manifest,
          readFileWindow,
          runTurn: adjudicationTurn,
          adjudicatedBy: `${adjResolution.model} (${adjResolution.harness})`,
          budget: sharedBudget,
          maxAdjudications: DEFAULT_REVIEW_INTELLIGENCE_BUDGET.adjudication.maxAdjudications,
        };
      }
      // The predicted-risk cross-check (#181), the LAST transform: reconcile the
      // hypothesis's predicted risks against the surfaced findings, so a risk marked
      // `confirmed` is addressed by a finding that actually surfaces. Deterministic,
      // $0 — absent a hypothesis it returns the review unchanged.
      surfacedReview = attachRiskCrossCheck(verified, hypothesis);
    } else {
      // Reaching here under DEEP review means there is no Claude verifier (e.g. a
      // Codex-only review). Announce that honestly: every finding that WOULD have been
      // verified gets an explicit unavailable caveat. Quick review stays unchanged
      // because it never promised verification. The cross-check is a free deterministic
      // step over whichever honest surface applies.
      const surfaced = projectUnavailableDeepVerification(flagged, deepReview);
      surfacedReview = attachRiskCrossCheck(surfaced, hypothesis);
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
    // ── verify-ui (#183): mount the changed UI surface, screenshot, a11y, intent ──
    // The classifier is deterministic and $0. A backend-only changeset records the
    // distinct `not-ui` status SYNCHRONOUSLY (no turn, no enrichment cycle) — "not
    // applicable", never an all-clear. A UI-touching deep review with a Claude adapter
    // gets ONE budget-bounded turn, but that turn is SLOW (install/build/mount), so it
    // rides the SAME non-blocking late-enrichment channel as adjudication (#349 lesson):
    // it NEVER delays the immediate row/canvas delivery, and its observations (ordinary
    // findings) + status replace the rows via `flagged.adjudication` when it lands.
    const uiClassification = classifyUiSurface(patchset.files);
    const immediate = applyImmediateUiVerification(stamped, {
      touchesUi: uiClassification.touchesUi,
      classifierVersion: uiClassification.version,
      deepReview,
      verifierAvailable: Boolean(adapter),
    });
    const uiVerification =
      immediate.status === "ok" && deepReview && adapter && uiClassification.touchesUi
        ? (async () => {
            const evidenceRun = await beginUiEvidenceRun(
              join(dataDir, "ui-evidence"),
              review.id,
              patchset.id,
            );
            try {
              const uiResult = await runUiVerification({
                files: patchset.files,
                hunks: decomposition.hunks,
                ...(intent ? { intent } : {}),
                evidenceDir: evidenceRun.directory,
                runTurn: createUiVerificationTurn(adapter, { cwd: review.repositoryRoot }),
                budget: sharedBudget,
                inspectEvidence: (path) => inspectUiEvidence(evidenceRun.directory, path),
                maxTurns: DEFAULT_REVIEW_INTELLIGENCE_BUDGET.uiVerification.maxTurns,
              });
              const bound = bindUiEvidenceRun(uiResult, evidenceRun);
              await completeUiEvidenceRun(
                evidenceRun,
                bound.status.status === "ran" && bound.status.screenshots.length > 0,
              );
              return bound;
            } catch (error) {
              await completeUiEvidenceRun(evidenceRun, false);
              throw error;
            }
          })()
        : null;
    const adjudicated =
      adjudicationOptions &&
      immediate.status === "ok" &&
      immediate.findings.some((finding) => finding.agreement.kind === "disagree")
        ? adjudicateFlaggedReview(immediate, adjudicationOptions).then(({ review }) => review)
        : null;
    // The two late passes start independently and compose only when their results are
    // ready. The immediate response says late enrichment was scheduled, so an all-concur
    // or zero-row renderer polls too; neither turn delays row delivery (Rule Zero).
    const composed = composeFlaggedLateEnrichment({
      immediate,
      adjudication: adjudicated,
      uiVerification,
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
      runFlaggedReviewWithContextFeed(review, deepReview, contextFeed, session),
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
  rehydration = createProactiveRehydration({
    store: snapshotStore,
    generator: snapshotGenerator,
    narrate: (event) => {
      // Fan background rehydration out to every connected client. The optional
      // caller hook stays for non-WS embedders; the WS listener reaches the sockets
      // that replaced the per-window `webContents.send` broadcast (#378).
      options.broadcastProgress?.(PROACTIVE_REHYDRATION_COMMAND_ID, event);
      wsListener?.broadcastProgress(PROACTIVE_REHYDRATION_COMMAND_ID, event);
    },
    runNoveltyPass: (repoKey) => liveNoveltyLifecycle.advanceRepo(repoKey),
    runKnowledgePass: async ({ repoKey, repoRoot, fromOid, toOid }) => {
      const { locus, distroCwd } = locusContextForRepo(repoRoot);
      const { adapter } = await getClaudeHarness(locus, distroCwd);
      if (!adapter) return false;
      const reader = new ProjectContextReader(snapshotStore);
      const knowledgeStore = new KnowledgeStore(snapshotStore);
      const common = {
        reader,
        knowledgeStore,
        port: adapter,
        repoKey,
        repoRoot,
        baseOid: toOid,
      };
      const result = await runKnowledgeDeltaForRepo({ ...common, fromOid });
      if (result.status === "ok") return true;
      if (result.status !== "no-prior-set") return false;
      const initial = await enrichKnowledgeForRepo(common);
      return initial.status === "ok";
    },
  });
  // At launch, resume warming every project whose Repo Map already exists.
  for (const project of projectStore.list()) void rehydration.ensureForProject(project);
  // The initial context dump's core, wrapped below so a successful process also starts
  // keeping that project's freshly-built Repo Map warm.
  const processProjectCore = createProcessProject({
    generate: (repoRoot, options) => snapshotGenerator.generate(repoRoot, options),
    listProjects: () => projectStore.list(),
  });
  // The global (app-side, personal) config store — layer 1 of the settings ladder
  // (wireframe #15). A plain document at `~/.rennet/config.json`, sibling to the
  // project snapshot store; holds the reviewer's scheme, never a repo fact.
  const configStore = new FileConfigStore(defaultGlobalConfigPath());
  // The device pairing store (issue #380): server-side secret store for remote
  // device tokens (hashed at rest in `~/.rennet/devices.json`). Shared between the
  // `pairing.*` commands (below) and the WS listener's handshake token check.
  const pairingStore = new PairingStore();
  // The push-token store (issue #383 M1): one row per paired device, keyed by device id,
  // in `~/.rennet/push-tokens.sqlite`. Shared between `device.registerPush` (set/delete),
  // the attention planner (list + dead-token cleanup), and revoke (delete stops pushes).
  const pushTokenStore = new PushTokenStore();
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
  const publishConsent = createPublishConsentAuthority();
  // The live orchestrator turn runner resolves the `orchestrator-chat` council seat
  // across both real HarnessPort adapters. Claude receives the in-process canvasOps
  // server; a Codex-selected path receives the same backend through the external
  // loopback transport. It reuses the memoized discoveries and the app-owned store under
  // `~/.rennet/projects/` (issue #188 — `baseDir` omitted, so it inherits
  // `defaultProjectsBaseDir()`). It is wired into the command-router composition
  // here; the conversational command that would drive a turn per user question is
  // the DEFERRED UI loop.
  const orchestratorTurn = createOrchestratorTurnRunner({
    resolveLocus: locusForRepo,
    resolveHarness: async (repoRoot) => {
      const { locus, distroCwd } = locusContextForRepo(repoRoot);
      const claude = await getClaudeHarness(locus, distroCwd);
      const codex = await getCodexResolution(locus);
      const claudePresent = claude.adapter !== null;
      const codexPresent = codex.agenticPort !== null;
      // omp fallback (#26): the deliberately minimal selection policy lives in the pure
      // `resolveOrchestratorHarnessSelection` — omp serves the seat ONLY when neither
      // Claude nor Codex is installed (where today the seat was null); otherwise the
      // council decision below is returned UNCHANGED. The omp resolution is memoized like
      // the others and only awaited on the sole-installed path (never a probe when the
      // council already has a seat).
      const ompResolvePort =
        claudePresent || codexPresent
          ? null
          : await (async () => {
              const ompPort = (await getOmpResolution()).agenticPort;
              return ompPort
                ? (mcpServers: Readonly<Record<string, { readonly url: string }>>) =>
                    Promise.resolve(ompPort(mcpServers))
                : null;
            })();
      return resolveOrchestratorHarnessSelection({
        claudePresent,
        codexPresent,
        ompResolvePort,
        council: () => {
          const installed: CouncilHarnessId[] = [];
          if (claudePresent) installed.push("claude-code");
          if (codexPresent) installed.push("codex");
          const assignment = resolveAssignment("orchestrator-chat", {
            availability: { installed },
          });
          if (assignment.kind !== "model") return null;
          const agenticPort = codex.agenticPort;
          if (assignment.harness === "codex" && agenticPort) {
            return {
              harness: "codex",
              model: assignment.model,
              resolvePort: (mcpServers) => Promise.resolve(agenticPort(mcpServers)),
            };
          }
          const claudePath = claude.discovery.chosen?.path;
          return assignment.harness === "claude-code" && claudePath
            ? { harness: "claude-code", claudePath, model: assignment.model }
            : null;
        },
      });
    },
    env,
    backend: {
      resolveKnowledgePort: async (repoRoot) => {
        const { locus, distroCwd } = locusContextForRepo(repoRoot);
        return (await getClaudeHarness(locus, distroCwd)).adapter;
      },
      noveltyLifecycle: liveNoveltyLifecycle,
    },
  });
  // #251: the durable conversation store (~/.rennet/threads). Backs both re-attach
  // (reload persisted threads, crash-recovered) and persistence (write a streaming
  // placeholder that recovers as interrupted if this process dies mid-answer).
  const threadStore = new FileThreadStore();
  const dispatch = createDispatch({
    service,
    allowedRoots,
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
    orchestratorTurn,
    publishPort,
    submitPullRequest,
    publishConsent,
    // The write-enabled handoff turn (issue #18): brackets a live `claude` write turn
    // (fully capable, Bash included — Rai's call) with git checkpoints and returns the
    // turn diff. Reuses the SAME memoized `claude` discovery the review pipeline uses
    // (R2 subscription OAuth). Refuses a repo with submodules (Codex F6) and answers an
    // honest failed turn when no `claude` is installed — never a fabricated success.
    runHandoffTurn: async ({ repoRoot, prompt }) => {
      const locus = locusForRepo(repoRoot);
      // The SDK prepends this distro cwd to its direct wsl.exe spawn.
      const distroCwd =
        locus.kind === "wsl" ? (toDistroPath(repoRoot, locus.distro) ?? undefined) : undefined;
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
      return runHandoffTurnCore({
        repoRoot,
        prompt,
        runPort: claudeHandoffRunPort(adapter),
        checkpoint: new GitCheckpointStore(repoRoot, locus),
      });
    },
    chooseRepository,
    openPullRequest,
    startWatching: (root: string) =>
      watcher.start(
        root,
        () => {
          repositoryDirty = true;
        },
        locusForRepo(root),
      ),
    isRepositoryDirty: () => repositoryDirty,
    setRepositoryDirty: (value: boolean) => {
      repositoryDirty = value;
    },
    buildCanvases: buildCanvasesForReview,
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
      if (processed) void rehydration?.ensureForProject(processed);
      return result;
    },
    discoverProject: ({ path, kind }) =>
      discoverProject(defaultProjectDiscoveryDeps(gitForRepo(path)), path, kind),
    detectHarnesses,
    github: githubAccount,
    // Project detail (issue #37): the unified smart list's substrate. The LOCAL half
    // is real worktrees/branches with dirty/ahead/behind from git; B2 wires the live
    // GitHub OPEN-PR set behind the same boundary via the auth-ladder PR source (null
    // when auth is unavailable → the local-only list). An unknown projectId degrades
    // to an empty detail (fail-safe, mirroring the project store) rather than throwing.
    projectDetail: async (projectId) => {
      const project = projectStore.list().find((entry) => entry.id === projectId);
      if (!project) {
        return { viewer: { login: "you" }, locals: [], prs: [], truncated: false };
      }
      const { source, authUnavailable } = await resolveProjectPrSource();
      const projectRoot = project.openPath || project.path;
      const detail = await loadProjectDetail(
        defaultProjectDetailSourceDeps(gitForRepo(projectRoot), source ?? undefined),
        project,
      );
      return authUnavailable ? { ...detail, authUnavailable } : detail;
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
    flaggedReview: runFlaggedReview,
    // The verify-ui screenshot read (#183): confined to the review's own evidence
    // directory under the app's user-data dir — the SAME `<userData>/ui-evidence/
    // <reviewId>/` the verify-ui turn wrote its PNGs into. Fail-closed (escape/missing
    // → null), no spend, no egress.
    readUiEvidence: (reviewId, path) =>
      readUiEvidence(join(dataDir, "ui-evidence"), reviewId, path),
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
    //   • askOrchestrator drives the live `claude` turn over the in-process
    //     canvasOps@2 MCP server (`orchestratorTurn`) — the orchestrator reads the
    //     review through context.map/file/novelty and answers. The pipeline it turns
    //     over is a DETERMINISTIC-FLOOR build (no lens/model turns): the ask's model
    //     spend is the one orchestrator turn, not a fresh lens review.
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
    reviewAsk: createLiveReviewAskPorts({
      // Dispatch resolves + freshness-pins the review (and its patchset) and hands the
      // SAME snapshot to both legs, so the ports never re-resolve. The pipeline is a
      // deterministic-floor build (no lens/model turns): the ask's model spend is the
      // ONE orchestrator turn, not a fresh lens review.
      buildPipeline: (review) =>
        buildReviewCanvases({
          reviewId: review.id,
          patchset: activePatchset(review),
          dispositions: review.dispositions,
          budget: createInvocationBudget(0),
        }),
      orchestratorTurn,
      askCodex: async ({ review, question, abortController }) => {
        // The ask executor is bound to the RESOLVED absolute codex, same as the
        // pipeline seat (bead workspace-6qp15), and to the review's locus (#334) so a
        // WSL project asks the distro's codex. A null executor means no codex resolved
        // — surface that honestly rather than shelling a bad `codex`.
        const { locus } = locusContextForRepo(review.repositoryRoot);
        const codex = await getCodexResolution(locus);
        if (codex.executor === null) {
          return {
            model: CODEX_ASK_LABEL,
            answer: "Codex is not installed, so no second opinion is available.",
          };
        }
        // Thread the quit-abort controller (#251 criterion 4) → execa's cancelSignal.
        return createLiveCodexAsk({ executor: codex.executor })({
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
    // Rephrases the successor review's DETERMINISTIC delta account into a one-glance
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
    composeBundle: createLiveComposeBundle({
      claudePort: claudeAdapterForRepo,
      codexExecutor: codexExecutorForRepo,
    }),
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
      readGlobalState: () => configStore.readState(),
      updateGlobal: (update) => configStore.update(update),
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
      applyLocus: ({ repoKey, locus }) => {
        snapshotStore.updateConfig(repoKey, (current) => {
          if (locus === null) {
            // Clear the override back to auto-detection (drop the field entirely).
            const next: Record<string, unknown> = { ...current };
            delete next.locus;
            return next as unknown as typeof current;
          }
          return { ...current, locus };
        });
      },
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
    serverVersion: options.serverVersion ?? "0.0.0-dev",
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
    listen: configStore.read().daemon?.listen,
    // The served browser UI (#381); absent ⇒ headless.
    uiDist: options.uiDist,
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
    void wsListener?.close();
  };
  return { dispatch, shutdown, wsPort: wsListener.port, wsHost: wsListener.host };
}
