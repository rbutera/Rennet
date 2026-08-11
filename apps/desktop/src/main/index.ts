import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  applyVisibilitySwitch,
  CLAUDE_TESTED_RANGE,
  type ClaudeHarnessResult,
  type CodexAvailability,
  claudeHandoffRunPort,
  cleanupWorktree,
  createClaudeHarness,
  createCodexExecutor,
  createCodexUtilityAdapter,
  createCoverageTurn,
  createGitHubProjectPrSource,
  createRefPinner,
  createVerificationFileReaderForPatchset,
  createVerificationTurn,
  defaultCodexDiscoveryDeps,
  defaultCodexExecEffects,
  defaultDiscoveryDeps,
  defaultGlobalConfigPath,
  defaultProjectDetailSourceDeps,
  defaultProjectDiscoveryDeps,
  deriveProjectDraft,
  discoverClaude,
  discoverCodex,
  discoverProject,
  discoverWorktreeIdentities,
  execaGit,
  FileConfigStore,
  FileProjectStore,
  type GhRunner,
  GitCaptureAdapter,
  GitCheckpointStore,
  GitHubChangesetSource,
  GitHubForgeAdapter,
  GitHubPublishAdapter,
  type HttpFetch,
  loadConventionCatalogue,
  loadProjectDetail,
  type ProjectPrSource,
  ProjectSnapshotGenerator,
  parseGitHubPrRef,
  RepoWatcher,
  readOpenSpecChange,
  repoHasSubmodules,
  resolveGitHubAuth,
  SqliteReviewStore,
  snapshotStoreFor,
} from "@rennet/adapters";
import {
  type AdmittedDocument,
  attachRiskCrossCheck,
  buildOfferedManifest,
  buildReviewCanvases,
  type CodexUtilityPort,
  createHarnessRunTurn,
  createInvocationBudget,
  DEFAULT_MAX_HARNESS_INVOCATIONS,
  DEFAULT_MAX_VERIFICATIONS,
  decompose,
  guardSeatTurn,
  markVerificationUnavailable,
  patchsetIntentToReviewIntent,
  ReviewService,
  resolveDualSeat,
  runCoverageMapping,
  runDecisionAngle,
  runDualFindingReview,
  runHandoffTurn as runHandoffTurnCore,
  runHypothesisPass,
  runNoiseAngle,
  verifyFlaggedReview,
} from "@rennet/core";
import { type DetectedHarness, isCommandName, type ProjectProcessEvent } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  ConventionCatalogue,
  CouncilHarnessId,
  DecisionsRunStatus,
  ElementDiffs,
  FlaggedReview,
  HypothesisStructure,
  NoiseReview,
  OpenSpecCoverage,
  Patchset,
  Review,
  ReviewEngine,
  ReviewHypothesis,
  ReviewNarration,
} from "@rennet/types";
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
import { createDispatch } from "./dispatch";
import { createDesktopReviewBackend } from "./live-review-backend";
import { EDITOR_CLIS, performOpenInEditor } from "./open-in-editor";
import { createOrchestratorTurnRunner } from "./orchestrator";
import {
  createProactiveRehydration,
  PROACTIVE_REHYDRATION_COMMAND_ID,
  type ProactiveRehydration,
} from "./proactive-rehydration";
import { createProcessProject } from "./process-project";
import { createPublishConsentAuthority } from "./publish-consent-authority";
import { createLiveRefinePort } from "./refine-comment-live";
import { CODEX_ASK_LABEL, createLiveCodexAsk, createLiveReviewAskPorts } from "./review-ask-live";
import { createSettingsComposition } from "./settings";
import { createLiveSymbolLookup, reviewPinnedToHead } from "./symbol-lookup-live";

const execFileAsync = promisify(execFile);

const IPC_CHANNEL = "rennet:invoke";
// The push channel a long-running command streams live progress on (today
// `project.process`'s snapshot-build narration). The renderer's `onProgress`
// bridge filters by the `commandId` it passed to `invoke`.
const PROGRESS_CHANNEL = "rennet:progress";
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
  /** The resolved absolute `codex` path (for the ask-AI executor), or null. */
  readonly binPath: string | null;
  /** The resolved codex version, stamped as harness provenance, or null. */
  readonly version: string | null;
}
let codexResolution: Promise<CodexResolution> | null = null;
function getCodexResolution(): Promise<CodexResolution> {
  codexResolution ??= (async (): Promise<CodexResolution> => {
    const explicitBin = process.env.RENNET_CODEX_BIN;
    const result = await discoverCodex(defaultCodexDiscoveryDeps(), {
      ...(explicitBin && explicitBin.length > 0 ? { explicitBin } : {}),
    });
    const chosen = result.chosen;
    if (!chosen) {
      return {
        availability: { available: false, version: null },
        port: null,
        binPath: null,
        version: null,
      };
    }
    const executor = createCodexExecutor(defaultCodexExecEffects, {
      bin: chosen.path,
      harnessVersion: chosen.version,
    });
    return {
      availability: { available: true, version: chosen.version },
      port: createCodexUtilityAdapter({ executor }),
      binPath: chosen.path,
      version: chosen.version,
    };
  })();
  return codexResolution;
}

function getCodexAvailability(): Promise<CodexAvailability> {
  return getCodexResolution().then((resolution) => resolution.availability);
}

/** The Codex utility port bound to the resolved absolute binary, or null when no
 *  codex resolved. Null here is the pipeline's "no Codex seat" signal — it degrades
 *  to single-Claude with the existing honest DEGRADED marker. */
function getCodexPort(): Promise<CodexUtilityPort | null> {
  return getCodexResolution().then((resolution) => resolution.port);
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
// Proactive snapshot rehydration (#143, the snapshot half): keeps each built
// project's Repo Map (ProjectSnapshot) warm as its reference branch advances — NOT
// the LLM knowledge layer. Assigned in `whenReady`, torn down on quit.
let rehydration: ProactiveRehydration | null = null;

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
async function buildCanvasesForReview(review: Review): Promise<{
  canvases: Record<CanvasAngle, Canvas>;
  elementDiffs: ElementDiffs;
  narration?: ReviewNarration;
  engine: ReviewEngine;
  /** How the Decisions lens's producer ran (issue #137): discerned vs failed. */
  decisionsRun: DecisionsRunStatus;
  /** The committed hypothesis (#178), when one was produced; the human's reading frame. */
  hypothesis?: ReviewHypothesis;
}> {
  const patchset = activePatchset(review);
  const { adapter } = await getClaudeHarness();
  const codex = await getCodexAvailability();
  const codexPort = await getCodexPort();
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
  // and every lens runs exactly as before.
  const hypothesis = await computeReviewHypothesis(review, patchset, adapter);

  // The per-project convention checklist (#180), sourced once and fed to the
  // Decisions runner as a labelled layer. Absent (no catalogue file), the runner
  // reasons exactly as before.
  const conventions = loadReviewConventions(review);

  const decisions = await runDecisionsForReview(review, patchset, adapter, hypothesis, conventions);

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
    ...(codexPort ? { codexPort } : {}),
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
    ...(hypothesis ? { hypothesis } : {}),
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
  const budget = createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS);
  // The change's stated intent (#136), projected from the frozen capture on the
  // patchset. Absent (a no-PR working-tree review with no spec touched) it is
  // undefined and the pass runs on structure + repo context alone — the honest
  // degrade, unchanged from before intent capture landed.
  const intent = patchsetIntentToReviewIntent(patchset.intent);
  const result = await runHypothesisPass({
    patchsetId: patchset.id,
    manifest,
    structure,
    ...(intent ? { intent } : {}),
    provenance: HYPOTHESIS_PROVENANCE_SEED,
    // A thrown/rejected turn (a session/transport construction exception, #96)
    // degrades to a turn-failure rather than crashing the command.
    runTurn: guardSeatTurn(runHypothesisTurn),
    budget,
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
 * the decision angle on the user's `claude` (subscription OAuth), budget-gated. It
 * is its OWN live-budget-gated action, distinct from `review.canvases`'s model
 * phase, so the ceiling stops decision spend without stopping the review (R10,
 * fail-closed). On `ok` its emitted `decision.record` document is returned as the
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
  const budget = createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS);
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
async function runFlaggedReview(review: Review, deepReview = true): Promise<FlaggedReview> {
  const patchset = activePatchset(review);
  const { adapter } = await getClaudeHarness();
  const codex = await getCodexAvailability();
  const codexPort = await getCodexPort();
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

  // Each seat is its OWN live-budget-gated action (R10, fail-closed): the ceiling
  // stops spend, never the review. The dual runner guards each seat's turn (a
  // thrown Codex spawn degrades to a failed seat, then the reconcile degrades) and
  // owns the reconcile + the honest single-provider degradation.
  // The per-project convention checklist (#180), fed to BOTH seats as a labelled
  // layer. Absent (no catalogue file), each seat assembles exactly as before.
  const conventions = loadReviewConventions(review);

  // The committed hypothesis (#178) and the change's stated intent (#136), fed to
  // BOTH finding seats so the Flagged lens reasons over the same disconfirmation
  // prior + PR intent the Decisions runner already gets (issue #210) — the whole
  // point of hypothesis-first is that it shapes EVERY finding, not just decisions.
  // The hypothesis is produced ONCE here for the flagged path (its own budget-gated
  // action, from the change's structure + intent + repo context, never the hunk
  // bodies, so the prior stays genuine); absent an adapter or on a failed pass it is
  // undefined. The intent is projected from the frozen capture on the patchset;
  // absent a captured surface it is undefined. With BOTH undefined the finding
  // assembly is byte-identical to before this change (no regression).
  const hypothesis = await computeReviewHypothesis(review, patchset, adapter);
  const intent = patchsetIntentToReviewIntent(patchset.intent);

  const { review: flagged } = await runDualFindingReview({
    deepReview,
    patchsetId: patchset.id,
    manifest,
    seats,
    makeBudget: () => createInvocationBudget(DEFAULT_MAX_HARNESS_INVOCATIONS),
    ...(intent ? { intent } : {}),
    ...(hypothesis ? { hypothesis } : {}),
    ...(conventions ? { conventions } : {}),
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
  if (deepReview && adapter) {
    const readFileWindow = createVerificationFileReaderForPatchset({
      patchset,
      hunks: decomposition.hunks,
      git: execaGit,
    });
    const runTurn = createVerificationTurn(adapter, { cwd: review.repositoryRoot });
    // BUDGET-GATE (Rule 75, vital money circuit): `maxVerifications` caps how many
    // findings are verified — the over-cap remainder surfaces an honest "not verified"
    // caveat chip (CAP_CAVEAT), NEVER a silent skip that would read as an all-clear —
    // and the invocation budget bounds actual model turns (one per file batch,
    // fail-closed). Both limits surface on the findings themselves; the returned
    // telemetry is the aggregate of those same per-finding chips, so no capped or
    // refused finding is dropped without a visible caveat.
    const { review: verified } = await verifyFlaggedReview(flagged, {
      manifest,
      readFileWindow,
      runTurn,
      budget: createInvocationBudget(DEFAULT_MAX_VERIFICATIONS),
      maxVerifications: DEFAULT_MAX_VERIFICATIONS,
    });
    // The predicted-risk cross-check (#181), the LAST transform: reconcile the
    // hypothesis's predicted risks against the VERIFIED findings (after refuted
    // ones were dropped), so a risk marked `confirmed` is addressed by a finding
    // that actually surfaces. Deterministic, $0 — absent a hypothesis it returns
    // `verified` unchanged.
    return attachRiskCrossCheck(verified, hypothesis);
  }
  // DEEP review requested but NO Claude verifier (e.g. Codex-only: findings were
  // produced by the Codex seat, but verification needs the Claude adapter). Announce it
  // honestly (P0-3): every finding that WOULD have been verified gets an explicit
  // "verification unavailable" inconclusive caveat, so an absent chip never reads as an
  // all-clear while deep review appears active. `adapter` is falsy here (we are past the
  // branch above), so this is exactly the no-verifier deep case.
  if (deepReview) {
    return attachRiskCrossCheck(markVerificationUnavailable(flagged), hypothesis);
  }
  // Quick review (single-seat, unverified): the cross-check still runs — it is a
  // free deterministic step — over the single seat's own findings. No chip, byte-
  // identical to before (quick review never promised verification).
  return attachRiskCrossCheck(flagged, hypothesis);
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
  const change = await readOpenSpecChange(patchset, execaGit);
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

  const { adapter } = await getClaudeHarness();
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
    return dispatch(name, input, { emitProgress });
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
  projectStore = new FileProjectStore(join(app.getPath("userData"), "projects.json"));
  service = new ReviewService(capture, store);
  // The ProjectSnapshot generator over the app-owned LOCAL-FIRST store under
  // `~/.rennet/projects/` (issue #188 default base dir). Drives the initial context
  // dump: `project.process` builds each included repo's snapshot through this, and
  // its real stages become the processing screen's live narration. The store is
  // SHARED with the settings surface (below) so the per-project `config.json`
  // (visibility/promotion) they read and write is the same one the generator keys.
  const snapshotStore = snapshotStoreFor();
  const snapshotGenerator = new ProjectSnapshotGenerator({ store: snapshotStore });
  // Proactive snapshot rehydration (#143, the snapshot half): keep each already-built
  // project's Repo Map (ProjectSnapshot) warm as its reference branch advances (a
  // fetch, a local commit, a rebase). This does NOT refresh the LLM knowledge layer
  // (context.knowledge) — that stays unwired. The background pass narrates on the SAME
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
  const publishConsent = createPublishConsentAuthority();
  // The live orchestrator turn runner (issue #13, wave 2): composes the wave-1 live
  // backend + the lean primer + a real `claude` turn over the in-process canvasOps@2
  // MCP server. It reuses the SAME memoized `claude` discovery the review pipeline
  // uses (R2 subscription OAuth) and the app-owned LOCAL-FIRST snapshot store under
  // `~/.rennet/projects/` (issue #188 — `baseDir` omitted, so it inherits
  // `defaultProjectsBaseDir()`). It is wired into the command-router composition
  // here; the conversational command that would drive a turn per user question is
  // the DEFERRED UI loop.
  const orchestratorTurn = createOrchestratorTurnRunner({
    resolveClaudePath: async () => (await getClaudeHarness()).discovery.chosen?.path ?? null,
    env: process.env,
  });
  dispatch = createDispatch({
    service,
    allowedRoots,
    orchestratorTurn,
    publishPort,
    publishConsent,
    // The write-enabled handoff turn (issue #18): brackets a live `claude` write turn
    // (fully capable, Bash included — Rai's call) with git checkpoints and returns the
    // turn diff. Reuses the SAME memoized `claude` discovery the review pipeline uses
    // (R2 subscription OAuth). Refuses a repo with submodules (Codex F6) and answers an
    // honest failed turn when no `claude` is installed — never a fabricated success.
    runHandoffTurn: async ({ repoRoot, bundle }) => {
      if (await repoHasSubmodules(repoRoot)) {
        return {
          status: "failed",
          reason:
            "Handoff does not support repositories with submodules yet: a coding agent's edits inside a submodule leave the gitlink unchanged, so the review would not see them. Refusing rather than losing them.",
          turnDiff: "",
          filesTouched: [],
        };
      }
      const { adapter } = await getClaudeHarness();
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
        bundle,
        runPort: claudeHandoffRunPort(adapter),
        checkpoint: new GitCheckpointStore(repoRoot),
      });
    },
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
      discoverProject(defaultProjectDiscoveryDeps(execaGit), path, kind),
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
      return loadProjectDetail(
        defaultProjectDetailSourceDeps(execaGit, prSource ?? undefined),
        project,
      );
    },
    // The merged-PR row's clean-up (B2), for real: `git worktree remove <path>` run
    // from the project's root. Non-forcing — a dirty worktree is refused and reported
    // ok:false, never swept. The `worktreeId` is the worktree path (LocalWork.id).
    cleanupWorktree: ({ projectId, worktreeId }) =>
      cleanupWorktree(
        {
          git: execaGit,
          resolveProjectRoot: async (id) => {
            const project = projectStore.list().find((entry) => entry.id === id);
            return project ? project.openPath || project.path : null;
          },
        },
        { projectId, worktreeId },
      ),
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
    openSpecChange: (review) => readOpenSpecChange(activePatchset(review), execaGit),
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
        });
        const live = await createDesktopReviewBackend(headReview, pipeline);
        return live.backend;
      },
    }),
    // review.openInEditor (Rai, wireframes #8): open a review file AT ITS LINE. Try a
    // line-jumping editor CLI (`<cli> -g file:line`, VS Code / Cursor / Sublime
    // family) first; fall back to an OS-level open (no line) only when none took it.
    // Path resolution + the escape-the-root refusal live in `performOpenInEditor`.
    openInEditor: ({ review, path, line }) =>
      performOpenInEditor(
        {
          launchAtLine: async (absPath, ln) => {
            for (const cli of EDITOR_CLIS) {
              try {
                await execFileAsync(cli, ["-g", `${absPath}:${ln}`]);
                return true;
              } catch {
                // Not installed / refused — try the next candidate editor.
              }
            }
            return false;
          },
          openPath: async (absPath) => (await shell.openPath(absPath)) === "",
        },
        { repositoryRoot: review.repositoryRoot, path, line },
      ),
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
        }),
      orchestratorTurn,
      askCodex: async ({ review, question }) => {
        // The ask executor is bound to the RESOLVED absolute codex, same as the
        // pipeline seat (bead workspace-6qp15). A null binPath means no codex
        // resolved — surface that honestly rather than shelling a bad `codex`.
        const codex = await getCodexResolution();
        if (codex.binPath === null) {
          return {
            model: CODEX_ASK_LABEL,
            answer: "Codex is not installed, so no second opinion is available.",
          };
        }
        const executor = createCodexExecutor(defaultCodexExecEffects, {
          bin: codex.binPath,
          ...(codex.version ? { harnessVersion: codex.version } : {}),
        });
        return createLiveCodexAsk({ executor })({ review, question });
      },
    }),
    // review.refine (issue #19): the LIVE comment-refinement producer. Rai's
    // headline feature — a rough note refined into a clean comment by a real,
    // council-routed model turn. Runs on WHICHEVER seat the council resolves: Codex
    // (Terra) when installed — the same absolute-binary resolution the ask-AI
    // executor and pipeline seat use (bead workspace-6qp15) — else the Claude
    // adapter (a light read-only session with the inline schema, the same
    // structured-output mechanism every pipeline lens seat uses; no docType).
    refineComment: createLiveRefinePort({
      claudePort: async () => (await getClaudeHarness()).adapter ?? null,
      codexExecutor: async () => {
        const codex = await getCodexResolution();
        if (codex.binPath === null) return null;
        return createCodexExecutor(defaultCodexExecEffects, {
          bin: codex.binPath,
          ...(codex.version ? { harnessVersion: codex.version } : {}),
        });
      },
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
            await execaGit(workingPath, ["rev-parse", "--show-toplevel"], { reject: true })
          ).trim();
        } catch {
          return null;
        }
        if (!topLevel) return null;
        try {
          return realpathSync(topLevel);
        } catch {
          return null;
        }
      },
      discoverWorkspaceRepos: async (project) => {
        const result = await discoverProject(
          defaultProjectDiscoveryDeps(execaGit),
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
          execaGit,
        );
        return { changed: preview.changed, gitignorePath: preview.gitignorePath };
      },
    }),
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
  rehydration?.closeAll();
  store?.close();
});
