import { execFile } from "node:child_process";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CLAUDE_TESTED_RANGE,
  type ClaudeHarnessResult,
  type CodexAvailability,
  cleanupWorktreeFixture,
  createClaudeHarness,
  createCodexUtilityAdapter,
  createRefPinner,
  defaultDiscoveryDeps,
  defaultProjectDiscoveryDeps,
  deriveProjectDraft,
  discoverClaude,
  discoverCodexAvailability,
  discoverProject,
  discoverWorktreeIdentities,
  execaGit,
  FileProjectStore,
  FileSettingsStore,
  type GhRunner,
  GitCaptureAdapter,
  GitHubChangesetSource,
  GitHubForgeAdapter,
  GitHubPublishAdapter,
  type HttpFetch,
  parseGitHubPrRef,
  projectDetailFixture,
  RepoWatcher,
  resolveGitHubAuth,
  reviewAskFixturePorts,
  SqliteReviewStore,
} from "@rennet/adapters";
import {
  type AdmittedDocument,
  buildOfferedManifest,
  buildReviewCanvases,
  type CodexUtilityPort,
  createHarnessRunTurn,
  createInvocationBudget,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  decompose,
  guardSeatTurn,
  ReviewService,
  runDecisionAngle,
  runFindingAngle,
  runNoiseAngle,
} from "@rennet/core";
import { type CommandName, type DetectedHarness, isCommandName } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  CouncilHarnessId,
  DecisionsRunStatus,
  ElementDiffs,
  FlaggedReview,
  NoiseReview,
  Patchset,
  Review,
  ReviewEngine,
  ReviewNarration,
} from "@rennet/types";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from "electron";
import { createDispatch } from "./dispatch";
import { createHarnessConsentAuthority } from "./harness-consent-authority";
import { createPublishConsentAuthority } from "./publish-consent-authority";

const execFileAsync = promisify(execFile);

const IPC_CHANNEL = "rennet:invoke";
const APP_ORIGIN = "app://rennet";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

if (process.env.RENNET_USER_DATA) app.setPath("userData", process.env.RENNET_USER_DATA);

const capture = new GitCaptureAdapter();
const watcher = new RepoWatcher();

// Composition root for the Claude harness. This binds the REAL
// @anthropic-ai/claude-agent-sdk query() (via createClaudeHarness) to the
// ClaudeAdapter, passing the user's own discovered `claude` binary so auth stays
// on their subscription OAuth (Master Plan R2). It is composed LAZILY and
// memoized: discovery spawns the user's login shell, so it runs on first use
// (the first `review.canvases`) rather than at launch, and passes the full
// process env so the spawned harness inherits PATH/HOME.
let claudeHarness: Promise<ClaudeHarnessResult> | null = null;
function getClaudeHarness(): Promise<ClaudeHarnessResult> {
  claudeHarness ??= createClaudeHarness({ env: process.env });
  return claudeHarness;
}

// The Codex seat, wired to the real `codex exec` executor (#66) and consulted by
// the Model Council when a seat resolves to a Codex model (#69, R39). Composed
// LAZILY and memoized like the Claude harness: the availability probe spawns
// `codex --version`, so it runs on first use, not at launch. The INVARIANT the
// composition root maintains — `codex` is in `installed` iff the port is passed
// to the pipeline — is what makes a Codex resolution always executable live.
let codexPort: CodexUtilityPort | null = null;
function getCodexPort(): CodexUtilityPort {
  codexPort ??= createCodexUtilityAdapter();
  return codexPort;
}

let codexAvailability: Promise<CodexAvailability> | null = null;
function getCodexAvailability(): Promise<CodexAvailability> {
  codexAvailability ??= discoverCodexAvailability();
  return codexAvailability;
}

// The ambient first-run detection line (issue #29): which harnesses are on the
// machine. Read-only, no repository, no model call — it is DISCLOSURE, felt not
// ceremonial. Memoized like the harness/codex probes: the claude probe spawns the
// login shell, so it runs once on the first front-door mount, not at launch. A
// probe that finds nothing simply drops that harness; the line degrades to
// whatever was found (or nothing), never an error.
let harnessDetection: Promise<DetectedHarness[]> | null = null;
async function probeGhVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["--version"], { env: process.env });
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

let store: SqliteReviewStore;
let settings: FileSettingsStore;
let projectStore: FileProjectStore;
let service: ReviewService;
let repositoryDirty = false;
const allowedRoots = new Set<string>();
let dispatch: ((name: CommandName, input: unknown) => Promise<unknown>) | null = null;

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
 */
async function openPullRequest(commandId: string, ref: string, repoPath: string): Promise<Review> {
  const prRef = parseGitHubPrRef(ref);
  if (!prRef) {
    throw new Error(`"${ref}" is not a pull request. Use owner/repo#123 or a GitHub PR URL.`);
  }
  const token = await resolveGitHubToken();
  const forge = new GitHubForgeAdapter({ http: publishHttp, token });
  const source = new GitHubChangesetSource({
    forge,
    git: execaGit,
    pin: createRefPinner(execaGit),
    // The candidate set is the single local clone the user picked. Identity
    // matching (owner/name vs the repo's remotes) decides whether it is the
    // right clone; it never falls back to a path-name guess.
    worktrees: { list: async () => [await discoverWorktreeIdentities(execaGit, repoPath)] },
  });
  const result = await source.open(prRef);
  if (!result.pin) {
    throw new Error(
      `The folder you chose is not a local clone of ${prRef.repo.owner}/${prRef.repo.name}. ` +
        "Open this PR from a local clone of that repository (REST-only review is not available yet).",
    );
  }
  return service.createReviewFromPatchset(commandId, result.patchset);
}

/**
 * The harness-backed live pipeline: decompose the review's active patchset,
 * gate on the Brita budget, and (when the user's `claude` is discoverable) drive
 * the decomposition angle + ordering pass on their subscription OAuth. With no
 * harness the deterministic floor still populates real canvases from the diff.
 */
async function buildCanvasesForReview(review: Review): Promise<{
  canvases: Record<CanvasAngle, Canvas>;
  elementDiffs: ElementDiffs;
  narration?: ReviewNarration;
  engine: ReviewEngine;
  /** How the Decisions lens's producer ran (issue #137): discerned vs failed. */
  decisionsRun: DecisionsRunStatus;
}> {
  const patchset = activePatchset(review);
  const { adapter } = await getClaudeHarness();
  const codex = await getCodexAvailability();
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
  const decisions = await runDecisionsForReview(review, patchset, adapter);

  const result = await buildReviewCanvases({
    reviewId: review.id,
    patchset,
    dispositions: review.dispositions,
    council: { availability: { installed } },
    // The Decisions lens (issue #137): the decision-extraction runner's real
    // `decision.record` docs, placed on the decisions canvas by the existing
    // projector. The runner reasons over the diff alone until the full #136 intent
    // capture (PR title/body + spec frozen on the patchset) lands; the runner
    // FULLY supports intent (proven by the live dogfood over {diff, PR body}).
    decisionDocs: decisions.docs,
    ...(codex.available ? { codexPort: getCodexPort() } : {}),
    ...(runDecompositionTurn ? { runDecompositionTurn } : {}),
    ...(runOrderingTurn ? { runOrderingTurn } : {}),
    ...(runNarrationTurn ? { runNarrationTurn } : {}),
  });
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
  };
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
 * the decision angle on the user's `claude` (subscription OAuth), budget-gated. It
 * is its OWN live-budget-gated action, distinct from `review.canvases`'s model
 * phase, so the ceiling stops decision spend without stopping the review (R10,
 * fail-closed). On `ok` its emitted `decision.record` document is returned as the
 * `decisionDocs` the projector groups; on a runner failure/budget refusal the doc
 * set is empty and the status is the LOUD `failed` state — "ran, nothing discerned"
 * (an ok run with an empty set) is never faked from "did not run".
 *
 * Live intent capture (PR title/body + spec) is the deferred #136 piece, so the app
 * path reasons over the diff alone for now; the runner reasons over {diff, intent}
 * whenever an intent is threaded (proven by the live dogfood).
 */
async function runDecisionsForReview(
  review: Review,
  patchset: Patchset,
  adapter: Awaited<ReturnType<typeof getClaudeHarness>>["adapter"],
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
  const budget = createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS);
  const result = await runDecisionAngle({
    patchsetId: patchset.id,
    manifest,
    provenance: DECISION_PROVENANCE_SEED,
    // A thrown/rejected turn (a session/transport construction exception, #96)
    // degrades to a turn-failure rather than crashing the command.
    runTurn: guardSeatTurn(runDecisionTurn),
    budget,
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
 * The live Flagged lens runner (issue #32/#138), replacing `flaggedReviewFixture`.
 * Decomposes the review's active patchset into the offered hunk manifest and runs
 * the finding angle on the user's `claude` (subscription OAuth), budget-gated. The
 * emitted `finding` documents become the lens's `FlaggedReview` behind the SAME
 * `flagged.review` boundary — the UI is unchanged. With no discoverable harness,
 * or on a runner failure/budget refusal, the lens gets the LOUD `failed` state —
 * "ran clean" is never faked from "did not run" (the empty-vs-failed distinction).
 */
async function runFlaggedReview(review: Review): Promise<FlaggedReview> {
  const patchset = activePatchset(review);
  const { adapter } = await getClaudeHarness();
  if (!adapter) {
    return { status: "failed", reason: "no model harness is available to run the review" };
  }
  const decomposition = decompose(patchset);
  const manifest = buildOfferedManifest(decomposition);
  // KNOWN §7 DEVIATION (as in buildCanvasesForReview): the read-only harness runs
  // with `cwd` on the live mutable checkout rather than an immutable materialisation,
  // because that layer is not built yet. Follow-up: materialise the active patchset
  // to an app-owned cache and point `cwd` there. Do NOT read this as satisfied.
  const runFindingTurn = createHarnessRunTurn(adapter, {
    docType: "finding",
    cwd: review.repositoryRoot,
  });
  // A finding run is its own live-budget-gated user action, distinct from
  // review.canvases; the ceiling stops spend, never the review (R10, fail-closed).
  const budget = createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS);
  const result = await runFindingAngle({
    patchsetId: patchset.id,
    manifest,
    provenance: FINDING_PROVENANCE_SEED,
    // A thrown/rejected turn (a session/transport construction exception, #96)
    // degrades to a turn-failure rather than crashing the command.
    runTurn: guardSeatTurn(runFindingTurn),
    budget,
  });
  if (result.status === "ok") {
    return { status: "ok", findings: result.findings };
  }
  return {
    status: "failed",
    reason: result.failureReason ?? "the finding runner did not complete",
  };
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
async function runNoiseReview(review: Review): Promise<NoiseReview> {
  const patchset = activePatchset(review);
  const { adapter } = await getClaudeHarness();
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
  const result = await runNoiseAngle({
    patchsetId: patchset.id,
    manifest,
    provenance: NOISE_PROVENANCE_SEED,
    // The runner OWNS the noise-job chip's model label; we ran the Claude harness.
    noiseJobModel: "Claude",
    // A thrown/rejected turn (a session/transport construction exception, #96)
    // degrades to a turn-failure rather than crashing the command.
    runTurn: guardSeatTurn(runNoiseTurn),
    budget,
  });
  if (result.status === "ok") {
    return { status: "ok", groups: result.groups };
  }
  return {
    status: "failed",
    reason: result.failureReason ?? "the noise runner did not complete",
  };
}

function registerCommandHandler(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, request: unknown) => {
    if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url))
      throw new Error("Untrusted renderer origin");
    if (!request || typeof request !== "object") throw new Error("Invalid command envelope");
    const { name, input } = request as { name?: unknown; input?: unknown };
    if (typeof name !== "string" || !isCommandName(name)) throw new Error("Unknown command");
    if (!dispatch) throw new Error("The command router is not ready");
    return dispatch(name, input);
  });
}

function registerAppProtocol(): void {
  const rendererRoot = resolve(__dirname, "../renderer");
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = resolve(rendererRoot, `.${normalize(requestedPath)}`);
    if (target !== rendererRoot && !target.startsWith(`${rendererRoot}/`)) {
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
    // desktop, not a painted in-app gradient. A transparent window lets the
    // compositor supply the material behind the frosted chrome. On macOS that is
    // native window vibrancy (the real desktop, blurred by the OS); other platforms
    // fall back to the renderer's own backdrop-filter over the transparent backing.
    // Content surfaces (panels, cards, code, paper) paint their own SOLID
    // backgrounds on top, so legibility never rides on the wallpaper (the #115
    // correction: glass is the frame, not the content).
    transparent: true,
    backgroundColor: "#00000000",
    ...(process.platform === "darwin"
      ? { vibrancy: "under-window" as const, visualEffectState: "active" as const }
      : {}),
    title: "Rennet",
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
  window.removeMenu();
  await window.loadURL(`${APP_ORIGIN}/`);
}

app.whenReady().then(async () => {
  store = new SqliteReviewStore(join(app.getPath("userData"), "rennet.sqlite"));
  settings = new FileSettingsStore(join(app.getPath("userData"), "settings.json"));
  projectStore = new FileProjectStore(join(app.getPath("userData"), "projects.json"));
  service = new ReviewService(capture, store);
  // The main-owned harness-run consent authority (bead workspace-fyvxb): mints a
  // single-use, review-bound token on the user's approval and consumes it before
  // the harness runs. In-process only — a restart must re-ask, never inherit a
  // stale authorization.
  const consent = createHarnessConsentAuthority();
  // The publish egress port + its consent authority (issue #21). The port constructs
  // requests purely (dry-run) and posts only via the gated `publish.review` command.
  const publishPort = new GitHubPublishAdapter({
    http: publishHttp,
    resolveToken: resolveGitHubToken,
  });
  const publishConsent = createPublishConsentAuthority();
  dispatch = createDispatch({
    service,
    allowedRoots,
    settings,
    consent,
    publishPort,
    publishConsent,
    chooseRepository,
    openPullRequest,
    startWatching: (root: string) =>
      watcher.start(root, () => {
        repositoryDirty = true;
      }),
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
    discoverProject: ({ path, kind }) =>
      discoverProject(defaultProjectDiscoveryDeps(execaGit), path, kind),
    detectHarnesses,
    // Project detail (issue #37): the unified smart list's substrate. Live git +
    // GitHub wiring is a follow-up; a fixture stands behind the real command
    // boundary so the surface comes alive now.
    projectDetail: () => Promise.resolve(projectDetailFixture()),
    cleanupWorktree: () => Promise.resolve(cleanupWorktreeFixture()),
    // The Flagged lens (issue #138): the automated review layer's findings. This is
    // the LIVE finding-generation runner (#32) — a real model turn over the review's
    // diff, replacing the fixture. Dual-review aggregation (#41) is still a follow-up
    // (single-model MVP: agreement is concur 1/1). The boundary is unchanged.
    flaggedReview: runFlaggedReview,
    // The Noise lens (issue #34): the low-signal churn grouped away, each group tagged
    // rule vs noise job. This is the LIVE noise-classification runner — a real model
    // turn over the review's diff, replacing the fixture, behind the unchanged
    // `noiseReview` boundary. The deterministic mechanical-rules engine (a separate
    // admission authority for the `rule` groups) is a DEFERRED follow-up; the empty-
    // vs-failed distinction and the totality-floor ejection are honoured today.
    noiseReview: runNoiseReview,
    // review.ask (issue #139): the ports a review question reaches. The core
    // `askReview` router (invoked in dispatch) owns the orchestrator-once /
    // both-adds-codex / never-synthesize law; these ports are the deferred half —
    // canned answers stand behind the real typed boundary until the live
    // orchestrator/Codex sessions are wired, exactly as the flagged/noise fixtures
    // stand behind their read boundaries.
    reviewAsk: reviewAskFixturePorts(),
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  registerAppProtocol();
  registerCommandHandler();
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  void watcher.close();
  store?.close();
});
