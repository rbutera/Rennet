import { execFile } from "node:child_process";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  type ClaudeHarnessResult,
  type CodexAvailability,
  createClaudeHarness,
  createCodexUtilityAdapter,
  createRefPinner,
  discoverCodexAvailability,
  discoverWorktreeIdentities,
  execaGit,
  FileSettingsStore,
  type GhRunner,
  GitCaptureAdapter,
  GitHubChangesetSource,
  GitHubForgeAdapter,
  GitHubPublishAdapter,
  type HttpFetch,
  parseGitHubPrRef,
  RepoWatcher,
  resolveGitHubAuth,
  SqliteReviewStore,
} from "@rennet/adapters";
import {
  buildReviewCanvases,
  type CodexUtilityPort,
  createHarnessRunTurn,
  ReviewService,
} from "@rennet/core";
import { type CommandName, isCommandName } from "@rennet/protocol";
import type {
  Canvas,
  CanvasAngle,
  CouncilHarnessId,
  ElementDiffs,
  Patchset,
  Review,
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

  const result = await buildReviewCanvases({
    reviewId: review.id,
    patchset,
    dispositions: review.dispositions,
    council: { availability: { installed } },
    ...(codex.available ? { codexPort: getCodexPort() } : {}),
    ...(runDecompositionTurn ? { runDecompositionTurn } : {}),
    ...(runOrderingTurn ? { runOrderingTurn } : {}),
    ...(runNarrationTurn ? { runNarrationTurn } : {}),
  });
  return {
    canvases: result.canvases,
    elementDiffs: result.elementDiffs,
    narration: result.narration,
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
