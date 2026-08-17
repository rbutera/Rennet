import { execFile } from "node:child_process";
import { existsSync, constants as fsConstants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
  type GhRunner,
  GitCaptureAdapter,
  GitCheckpointStore,
  GitHubChangesetSource,
  GitHubForgeAdapter,
  GitHubPrSubmissionAdapter,
  GitHubPublishAdapter,
  gitForRepoFactory,
  type HttpFetch,
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
  repoHasSubmodules,
  repoRecordOf,
  resolveBaseRef,
  resolveForgeRemote,
  resolveGitHubAuth,
  runKnowledgeDeltaForRepo,
  SqliteReviewStore,
  snapshotStoreFor,
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
  locusCommand,
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
import {
  type DetectedHarness,
  isCommandName,
  menuRunPayloadSchema,
  type ProjectProcessEvent,
  type ReviewAskStreamEvent,
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
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from "electron";
import squirrelStartup from "electron-squirrel-startup";
import { startAutoUpdate } from "./auto-update";
import { attachCiSignal } from "./ci-signal";
import { createLiveDeltaDigestPort } from "./delta-digest-live";
import { createDispatch, type FlaggedReviewRun } from "./dispatch";
import { createLiveDraftPrBodyPort } from "./draft-pr-body-live";
import { stampBlockingStates } from "./flagged-blocking-states";
import { composeFlaggedLateEnrichment } from "./flagged-late-enrichment";
import { projectUnavailableDeepVerification } from "./flagged-review-verification";
import { applyImmediateUiVerification } from "./flagged-ui-verification";
import { createLiveComposeBundle } from "./handoff-compose-live";
import { createDesktopReviewBackend, createDesktopReviewContextFeed } from "./live-review-backend";
import { LiveTurnRegistry } from "./live-turn-registry";
import { applyMenuUpdate } from "./menu";
import {
  createEditorLaunchEffects,
  editorLaunchSpec,
  performOpenInEditor,
  resolveEditorExecutables,
} from "./open-in-editor";
import { createOrchestratorTurnRunner, resolveOrchestratorHarnessSelection } from "./orchestrator";
import {
  createProactiveRehydration,
  PROACTIVE_REHYDRATION_COMMAND_ID,
  type ProactiveRehydration,
} from "./proactive-rehydration";
import { createProcessProject } from "./process-project";
import { createPublishConsentAuthority } from "./publish-consent-authority";
import { createLiveRefinePort } from "./refine-comment-live";
import { CODEX_ASK_LABEL, createLiveCodexAsk, createLiveReviewAskPorts } from "./review-ask-live";
import { type ReviewContextFeed, runWithReviewContextFeed } from "./review-context-feed";
import type { ReviewIntelligenceSession } from "./review-intelligence-session";
import { loadReviewOwnership } from "./review-ownership";
import { buildReviewCanvasesInput } from "./review-pipeline-input";
import { createSettingsComposition } from "./settings";
import { createLiveSymbolLookup, reviewPinnedToHead } from "./symbol-lookup-live";
import { brandWindowIcon, resolveAppUserModelId } from "./window-identity";

// Squirrel (the win32 installer) launches the freshly-installed exe with a
// `--squirrel-install`/`--squirrel-updated`/`--squirrel-uninstall` argv while it
// wires up shortcuts, then kills it. electron-squirrel-startup handles those events
// (creating/removing the shortcuts) and returns true, in which case we must quit
// immediately and boot nothing else. No-op on macOS/Linux and on normal launches.
if (squirrelStartup) {
  app.quit();
}

const execFileAsync = promisify(execFile);

let editorExecutables: Promise<string[]> | null = null;
function getEditorExecutables(): Promise<string[]> {
  editorExecutables ??= (async () => {
    const discovery = defaultDiscoveryDeps();
    const loginShellPath = (await discovery.loginShellPath()) ?? "";
    return resolveEditorExecutables(
      {
        platform: process.platform,
        home: homedir(),
        inheritedPath: process.env.PATH ?? "",
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
  openPath: async (absPath) => (await shell.openPath(absPath)) === "",
});

const IPC_CHANNEL = "rennet:invoke";
// The push channel a long-running command streams live progress on (today
// `project.process`'s snapshot-build narration). The renderer's `onProgress`
// bridge filters by the `commandId` it passed to `invoke`.
const PROGRESS_CHANNEL = "rennet:progress";
// The push channel a review's conversation streams its token deltas on (#251). Keyed
// by `reviewId` (NOT commandId) so the renderer's `onAskStream` re-attaches after a
// reload while the turn keeps running in main. Each event carries its own turnId.
const ASK_STREAM_CHANNEL = "rennet:ask-stream";
// The application menu channels (#44): the renderer PROJECTS the registry into menu
// sections and pushes them on `menu-update`; MAIN builds `Menu.setApplicationMenu` and
// routes an item click back on `menu-run` as a command id the renderer runs.
const MENU_UPDATE_CHANNEL = "rennet:menu-update";
const MENU_RUN_CHANNEL = "rennet:menu-run";
const APP_ORIGIN = "app://rennet";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

if (process.env.RENNET_USER_DATA) app.setPath("userData", process.env.RENNET_USER_DATA);

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
      env: process.env,
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
      const explicitBin = process.env.RENNET_CODEX_BIN;
      const discoveryDeps =
        locus.kind === "wsl" ? await wslDiscoveryDeps(locus.distro) : defaultCodexDiscoveryDeps();
      const result = await discoverCodex(discoveryDeps, {
        // The RENNET_CODEX_BIN override is a host path; it never applies to a distro.
        ...(locus.kind === "host" && explicitBin && explicitBin.length > 0 ? { explicitBin } : {}),
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
        ...(locus.kind === "wsl" ? { locus } : {}),
      });
      const transport = createCodexTurnTransport(chosen.path, defaultCodexTransportEffects, locus);
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
    const explicitBin = process.env.RENNET_OMP_BIN;
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
// The gh probe is locus-aware (add-windows-support): host = `gh --version`, WSL =
// `wsl.exe -d <distro> -e gh --version`. The ambient first-run line is a MACHINE
// probe, so it uses the host; a per-project WSL gh probe passes the project's locus.
async function probeGhVersion(locus: Locus = HOST_LOCUS): Promise<string | null> {
  try {
    const { file, args } = locusCommand(locus, "gh", ["--version"]);
    const { stdout } = await execFileAsync(file, args, { env: process.env });
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}
function detectHarnesses(): Promise<DetectedHarness[]> {
  harnessDetection ??= (async (): Promise<DetectedHarness[]> => {
    const [claude, codex, gh] = await Promise.all([
      discoverClaude(defaultDiscoveryDeps(), CLAUDE_TESTED_RANGE).catch(() => null),
      getCodexAvailability().catch(() => null),
      probeGhVersion(),
    ]);
    const detected: DetectedHarness[] = [];
    if (claude?.chosen) detected.push({ id: "claude", version: claude.chosen.version });
    if (codex?.available) detected.push({ id: "codex", version: codex.version ?? null });
    if (gh !== null) detected.push({ id: "gh", version: gh });
    return detected;
  })();
  return harnessDetection;
}

// ── The GitHub egress composition (issue #21) ────────────────────────────────
// The outbound HTTP goes through electron `net.fetch`, so no code here holds a raw
// socket; the bearer token is resolved LAZILY via the auth ladder (`gh auth token`,
// rung 0) on the FIRST real publish, never at launch and never for a dry-run (which
// constructs the request without a credential). The token is never persisted.
const publishHttp: HttpFetch = async (url, init) => {
  const res = await net.fetch(url, init);
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

// `gh auth token` resolves the REST bearer on the host. For a WSL-locus project the
// git push already runs in the distro (see `submitPullRequest`); binding this token
// read to the distro's own `gh` is the remaining WSL publish-auth item tracked in the
// add-windows-support change (the host token still authenticates the REST create).
const runGhAuthToken: GhRunner = async () => {
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["auth", "token"], { env: process.env });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    // A non-zero exit (logged out) resolves with its code; a spawn failure (`gh`
    // absent, no `code`) rejects, which the auth ladder reads as gh-absent.
    const err = error as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof err.code !== "number") throw error;
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code };
  }
};

/** Resolve the GitHub bearer for a real egress; throws (never posts) when unavailable. */
async function resolveGitHubToken(): Promise<string> {
  const auth = await resolveGitHubAuth({
    gh: runGhAuthToken,
    http: publishHttp,
    // No pasted-PAT store is wired yet; rung 0 (`gh auth token`) is the credential.
    secretStore: { getGitHubToken: async () => null },
  });
  if (!auth.ok) throw new Error(`GitHub authentication is unavailable (${auth.reason})`);
  return auth.token;
}

// The live project-detail PR source (issue #37, B2). Resolved from the SAME auth
// ladder as egress, memoized so `project.detail` never re-runs `gh auth token`. When
// auth is unavailable it stays `null` and `project.detail` degrades to the local-only
// list (B1) — a missing token is a local-only surface, never a failed fetch rendered
// as "zero PRs". Resolution is lazy (first `project.detail`), never at launch.
let projectPrSource: Promise<ProjectPrSource | null> | null = null;
function resolveProjectPrSource(): Promise<ProjectPrSource | null> {
  projectPrSource ??= (async (): Promise<ProjectPrSource | null> => {
    const auth = await resolveGitHubAuth({
      gh: runGhAuthToken,
      http: publishHttp,
      secretStore: { getGitHubToken: async () => null },
    });
    if (!auth.ok) return null;
    return createGitHubProjectPrSource({ http: publishHttp, token: auth.token });
  })();
  return projectPrSource;
}

let store: SqliteReviewStore;
let projectStore: FileProjectStore;
let service: ReviewService;
let repositoryDirty = false;
const allowedRoots = new Set<string>();
let dispatch: ReturnType<typeof createDispatch> | null = null;
// Proactive Repo Map rehydration (#143/#243): keeps each built project's structural
// snapshot and model-backed knowledge warm as its reference branch advances.
// Assigned in `whenReady`, torn down on quit.
let rehydration: ProactiveRehydration | null = null;
// The in-flight conversation turns (#251, criterion 4). One registry for the app
// lifetime: dispatch registers each `review.ask` turn's AbortController and settles
// it when the turn finishes; `before-quit` aborts whatever is still in flight so a
// model child is asked to stop rather than surviving the quit.
const liveTurns = new LiveTurnRegistry();

function isTrustedAppUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "app:" &&
    url.hostname === "rennet" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function activePatchset(review: Review): Patchset {
  const patchset = review.patchsets.find((candidate) => candidate.id === review.activePatchsetId);
  if (!patchset) throw new Error("The active patchset is missing");
  return patchset;
}

/** The repository picker: the test-repo env (e2e) or the Electron directory dialog. */
async function chooseRepository(): Promise<string | null> {
  const testPath = process.env.RENNET_TEST_REPO;
  if (testPath) return testPath;
  const result = await dialog.showOpenDialog({
    title: "Choose a repository to review",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
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
  const token = await resolveGitHubToken();
  const forge = new GitHubForgeAdapter({ http: publishHttp, token });
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
    fetchCiStatus: async (ref, headOid, signal) => {
      const token = await resolveGitHubToken();
      return new GitHubForgeAdapter({ http: publishHttp, token }).fetchCiStatus(
        ref,
        headOid,
        signal,
      );
    },
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
            join(app.getPath("userData"), "ui-evidence"),
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

function registerCommandHandler(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, request: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url))
      throw new Error("Untrusted renderer origin");
    if (!request || typeof request !== "object") throw new Error("Invalid command envelope");
    const { name, input } = request as { name?: unknown; input?: unknown };
    if (typeof name !== "string" || !isCommandName(name)) throw new Error("Unknown command");
    if (!dispatch) throw new Error("The command router is not ready");
    // A command that carries a `commandId` may stream live progress; push each
    // event on the progress channel keyed by that id so the renderer can filter to
    // its own invocation. `sender.isDestroyed()` guards a window closed mid-build.
    const commandId =
      input &&
      typeof input === "object" &&
      typeof (input as { commandId?: unknown }).commandId === "string"
        ? (input as { commandId: string }).commandId
        : undefined;
    const emitProgress = commandId
      ? (progress: ProjectProcessEvent): void => {
          if (!event.sender.isDestroyed())
            event.sender.send(PROGRESS_CHANNEL, { commandId, event: progress });
        }
      : undefined;
    // #251: a review.ask carrying a reviewId may stream its answer's tokens; push each
    // event on the ask-stream channel keyed by that reviewId so the renderer filters to
    // its own review (and can re-attach by reviewId after a reload).
    const reviewId =
      input &&
      typeof input === "object" &&
      typeof (input as { reviewId?: unknown }).reviewId === "string"
        ? (input as { reviewId: string }).reviewId
        : undefined;
    const emitAskStream = reviewId
      ? (streamEvent: ReviewAskStreamEvent): void => {
          if (!event.sender.isDestroyed())
            event.sender.send(ASK_STREAM_CHANNEL, { reviewId, event: streamEvent });
        }
      : undefined;
    return dispatch(name, input, {
      emitProgress,
      progressRecipientId: event.sender.id,
      emitAskStream,
    });
  });
}

function registerMenuHandler(): void {
  // The renderer projects the registry into serializable sections (#44); MAIN builds
  // the Electron menu and sets it. A menu item click routes back as a command id the
  // renderer runs through the same handler the palette uses (single dispatcher). The
  // command accelerators are display-only, so a chord never double-fires.
  ipcMain.on(MENU_UPDATE_CHANNEL, (event, payload: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return;
    applyMenuUpdate(payload, {
      isMac: process.platform === "darwin",
      onRun: (id) => {
        const runPayload = menuRunPayloadSchema.parse({ id });
        if (!event.sender.isDestroyed()) event.sender.send(MENU_RUN_CHANNEL, runPayload);
      },
      buildFromTemplate: (template) => Menu.buildFromTemplate(template),
      setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
    });
  });
}

function registerAppProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = resolve(rendererRoot, `.${normalize(requestedPath)}`);
    if (target !== rendererRoot && !target.startsWith(rendererRoot + sep)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    // Real glass (issue #61): the CHROME is genuinely translucent over the actual
    // desktop, not a painted in-app gradient — the OS compositor supplies the
    // blurred material behind the frosted chrome. On macOS that is native window
    // vibrancy over a transparent window. On Windows transparency only works on a
    // FRAMELESS window (no titlebar, no drag) and gets NO compositor blur — the
    // raw desktop showed straight through — so win32 keeps the NATIVE frame
    // (titlebar, snap, drag) and asks DWM for the acrylic material instead
    // (Windows 11; older builds just get a dark solid backing). Content surfaces
    // (panels, cards, code, paper) paint their own SOLID backgrounds on top, so
    // legibility never rides on the wallpaper (the #115 correction: glass is the
    // frame, not the content).
    ...(process.platform === "darwin"
      ? {
          transparent: true,
          backgroundColor: "#00000000",
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : process.platform === "win32"
        ? { backgroundMaterial: "acrylic" as const, backgroundColor: "#00000000" }
        : { transparent: true, backgroundColor: "#00000000" }),
    title: "Rennet",
    // Dev runs (and Linux) have no exe-embedded icon, so without this they show the
    // default Electron icon in the titlebar/taskbar. Resolved lazily and only when
    // the brand file exists — the packaged win32 exe carries the `.ico` itself, so a
    // missing file degrades to Electron's default rather than throwing.
    icon: brandWindowIcon(__dirname, process.platform),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!isTrustedAppUrl(destination)) event.preventDefault();
  });
  // No `window.removeMenu()` — the application menu is now built from the registry
  // (#44) once the renderer sends its first `menu.update`. Until then Electron's
  // default menu stands (Edit/Window roles), never a missing menu bar.
  await window.loadURL(`${APP_ORIGIN}/`);
}

app.whenReady().then(async () => {
  // Stable Windows taskbar/toast identity — set before any window so grouping,
  // pinning, and notifications attach to this AUMID instead of a per-exe default. On
  // a Squirrel install we must match the id Squirrel stamped on the shortcut, or
  // toasts go dark; the resolver picks that automatically from the install layout.
  if (process.platform === "win32") {
    app.setAppUserModelId(resolveAppUserModelId(process.platform, process.execPath, existsSync));
  }
  // Auto-update, packaged builds only — dev/test runs have no release to pull and no
  // Squirrel/Squirrel.Mac feed. Best-effort and self-silencing (see auto-update.ts):
  // on unsigned macOS it no-ops instead of crashing; on Windows it activates once
  // Squirrel artifacts ship in a release.
  if (app.isPackaged) startAutoUpdate();
  store = new SqliteReviewStore(join(app.getPath("userData"), "rennet.sqlite"));
  projectStore = new FileProjectStore(join(app.getPath("userData"), "projects.json"));
  service = new ReviewService(capture, store);
  // The ProjectSnapshot generator over the app-owned LOCAL-FIRST store under
  // `~/.rennet/projects/` (issue #188 default base dir). Drives the initial context
  // dump: `project.process` builds each included repo's snapshot through this, and
  // its real stages become the processing screen's live narration. The store is
  // SHARED with the settings surface (below) so the per-project `config.json`
  // (visibility/promotion) they read and write is the same one the generator keys.
  const snapshotStore = liveSnapshotStore;
  const snapshotGenerator = new ProjectSnapshotGenerator({ store: snapshotStore, gitForRepo });
  // Proactive rehydration (#143/#243): keep each already-built project's structural
  // snapshot and knowledge warm as its reference branch advances. The background pass narrates on the SAME
  // `rennet:progress` push the processing screen uses, under a stable command id, so
  // the mechanism is visible-capable with no new protocol surface. It only warms repos
  // that already have a snapshot — it never cold-builds in the background.
  rehydration = createProactiveRehydration({
    store: snapshotStore,
    generator: snapshotGenerator,
    narrate: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(PROGRESS_CHANNEL, {
          commandId: PROACTIVE_REHYDRATION_COMMAND_ID,
          event,
        });
      }
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
  // The publish egress port + its consent authority (issue #21). The port constructs
  // requests purely (dry-run) and posts only via the gated `publish.review` command.
  const publishPort = new GitHubPublishAdapter({
    http: publishHttp,
    resolveToken: resolveGitHubToken,
  });
  // The own-branch PR submission (issue #257 / #107): push the review's own branch,
  // then open a real PR. Pushing your own branch is not publishing (AGENTS.md) — the
  // agent loop pushes freely — so this is a plain git push + a REST create, with the
  // repo's GitHub identity resolved from its own remotes (never a path-name guess).
  const prSubmissionAdapter = new GitHubPrSubmissionAdapter({
    http: publishHttp,
    resolveToken: resolveGitHubToken,
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
    env: process.env,
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
  dispatch = createDispatch({
    service,
    allowedRoots,
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
      const prSource = await resolveProjectPrSource();
      const projectRoot = project.openPath || project.path;
      return loadProjectDetail(
        defaultProjectDetailSourceDeps(gitForRepo(projectRoot), prSource ?? undefined),
        project,
      );
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
      readUiEvidence(join(app.getPath("userData"), "ui-evidence"), reviewId, path),
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
    // #251 re-attach: reload the conversation threads persisted for a review, crash-
    // recovered (a turn left streaming by a dead process reads back interrupted). No
    // live in-flight registry yet, so `inFlight` is empty — the main-alive live-reattach
    // case is a follow-on; the crash/kill → interrupted path is what this closes.
    reattachThreads: async ({ reviewId }) => ({
      threads: threadStore.loadThreads(reviewId),
      inFlight: [],
    }),
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
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  registerAppProtocol();
  registerCommandHandler();
  registerMenuHandler();
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  // #251 criterion 4: abort every in-flight conversation turn so a model child is
  // asked to stop rather than surviving the quit. This SIGNALS the turns — the codex
  // exec is force-killed by execa, but a claude child that ignores its abort cannot be
  // observed to exit (the SDK never exposes its PID), so this is a reap REQUEST, not a
  // confirmed kill. An aborted turn's `streaming` placeholder stays on disk and
  // recovers as `interrupted` on the next launch's reattach (criterion 3).
  liveTurns.abortAll();
  void watcher.close();
  rehydration?.closeAll();
  store?.close();
});
