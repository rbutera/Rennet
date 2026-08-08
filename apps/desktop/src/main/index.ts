import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ClaudeHarnessResult,
  type CodexAvailability,
  createClaudeHarness,
  createCodexUtilityAdapter,
  discoverCodexAvailability,
  FileSettingsStore,
  GitCaptureAdapter,
  RepoWatcher,
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
    backgroundColor: "#111318",
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
  dispatch = createDispatch({
    service,
    allowedRoots,
    settings,
    consent,
    chooseRepository,
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
