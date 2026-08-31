import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { app, autoUpdater, BrowserWindow, ipcMain } from "electron";
import { type IUpdateSource, UpdateSourceType, updateElectronApp } from "update-electron-app";

/** MAIN → renderer push AND renderer → MAIN invoke (replay) channel for readiness. */
export const UPDATE_READY_CHANNEL = "rennet:update-ready";
/** Renderer → MAIN one-way: the user confirmed the restart-into-update prompt. */
export const UPDATE_APPLY_CHANNEL = "rennet:update-apply";

export interface UpdateReadyInfo {
  /** Release name when the platform updater reported one; absent otherwise. */
  version?: string;
}

export interface UpdateReadiness {
  /** The cached downloaded-and-ready state, null until a download completes. */
  readonly ready: UpdateReadyInfo | null;
  /** Record a completed download and push it to every subscriber. */
  markDownloaded(releaseName?: unknown): void;
  /** Also notify this listener on each readiness change (the tray subscribes here). */
  subscribe(listener: (info: UpdateReadyInfo) => void): void;
}

/**
 * Testable readiness core: caches the downloaded release so late-loading (or
 * reloading) renderers can replay it, and broadcasts each transition. The badge
 * means READY — this only ever fires off a completed download, so the UI can
 * never claim an update it doesn't have (spec: desktop-update-notification).
 * The renderer badge rides the injected `broadcast`; the tray rides `subscribe` —
 * one store, two surfaces, no IPC hop between them.
 */
export function createUpdateReadiness(broadcast: (info: UpdateReadyInfo) => void): UpdateReadiness {
  let ready: UpdateReadyInfo | null = null;
  const listeners: Array<(info: UpdateReadyInfo) => void> = [];
  return {
    get ready() {
      return ready;
    },
    markDownloaded(releaseName?: unknown): void {
      const name = typeof releaseName === "string" ? releaseName.trim() : "";
      ready = name ? { version: name } : {};
      broadcast(ready);
      for (const listener of listeners) listener(ready);
    },
    subscribe(listener: (info: UpdateReadyInfo) => void): void {
      listeners.push(listener);
    },
  };
}

/** Numeric x.y.z compare; true when `a` is strictly newer than `b`. */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/**
 * Squirrel.Windows stages a downloaded update as a SIBLING `app-<version>`
 * directory and, from then on, answers every later `checkForUpdates` with
 * "update-not-available" — the comparison runs against the newest STAGED
 * version, not the running one. So `update-downloaded` fires exactly once, in
 * whichever run performed the staging; if the badge push was missed there (a
 * wedged renderer, a crash, a headless run — all observed on the lancelot test
 * bed, 2026-08-19), no later event ever comes and the badge never shows.
 *
 * This detects that state at boot: when a sibling app dir carries a strictly
 * newer version than the running one, the update is already downloaded and
 * ready, and the readiness cache can say so without any updater event.
 * Returns the newest staged version, or null (non-Squirrel layouts, macOS —
 * where Squirrel.Mac applies on relaunch instead of staging siblings — and any
 * read failure: best-effort, never throws).
 */
export function stagedNewerVersion(
  execPath: string,
  runningVersion: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32") return null;
  try {
    const appDir = dirname(execPath);
    if (!/^app-\d+\.\d+\.\d+$/.test(basename(appDir))) return null;
    let best: string | null = null;
    for (const entry of readdirSync(resolve(appDir, ".."))) {
      const match = /^app-(\d+\.\d+\.\d+)$/.exec(entry);
      if (!match?.[1]) continue;
      const version = match[1];
      if (semverGt(version, runningVersion) && (best === null || semverGt(version, best))) {
        best = version;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Where the update check looks, per platform.
 *
 * win32 asks GitHub Releases DIRECTLY: Squirrel.Windows only needs `RELEASES` +
 * the nupkg at a base URL, and GitHub's `releases/latest/download/` redirect
 * serves exactly that — no intermediary, no update.electronjs.org cache (which
 * was observed serving a stale "no update" for ~87 minutes after a publish,
 * lancelot 2026-08-19). darwin stays on update.electronjs.org: Squirrel.Mac
 * needs the JSON feed that service derives, and macOS auto-update is a silent
 * no-op until builds are Developer-ID-signed (issue #298) anyway. Either way the
 * egress is GitHub-or-Electron infrastructure only — no Rennet backend.
 */
export function updateSourceFor(platform: NodeJS.Platform, repo: string): IUpdateSource {
  if (platform === "win32") {
    return {
      type: UpdateSourceType.StaticStorage,
      baseUrl: `https://github.com/${repo}/releases/latest/download`,
    };
  }
  return { type: UpdateSourceType.ElectronPublicUpdateService, repo };
}

/** How often the staged-sibling state is re-checked (matches the update-check cadence). */
export const STAGED_POLL_INTERVAL_MS = 5 * 60_000;
/** Native quitAndInstall should terminate this process immediately after its state write. */
export const APPLY_HANDOFF_TIMEOUT_MS = 3_000;

/** The public repository updates come from. */
export const UPDATE_REPO = "rbutera/rennet";

const execFileAsync = promisify(execFile);

/**
 * The real macOS Developer-ID probe. `--deep --strict` hashes every binary in the bundle, so it
 * costs SECONDS on a packaged app — it runs off-thread (`execFile`, not `execFileSync`) because
 * synchronously it stalled the main process through renderer boot, starving IPC and the `app://`
 * protocol handler (perf audit 2026-08-31, §2 H2).
 */
async function codesignHasDeveloperId(appPath: string): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    const { stderr } = await execFileAsync("/usr/bin/codesign", [
      "--display",
      "--verbose=4",
      appPath,
    ]);
    return /Authority=Developer ID Application:/.test(stderr);
  } catch {
    return false;
  }
}

/**
 * A verifier that runs its probe AT MOST ONCE per app path: the running bundle's signature
 * cannot change while it runs, so the second caller for the same path reuses the first verdict —
 * and a caller arriving mid-probe joins the same promise rather than starting a second `codesign`
 * walk. Keyed by path, because a single-slot memo answers for whatever bundle asked FIRST, and
 * `hasDeveloperIdSignature` derives the path from an argument callers may vary.
 *
 * A REJECTION is not a verdict, so it is not kept: the real probe never rejects (it catches and
 * answers false), but an injected one can, and caching that promise would make one failed probe
 * the permanent answer for the life of the process.
 */
export function createSignatureVerifier(
  probe: (appPath: string) => Promise<boolean> = codesignHasDeveloperId,
): (appPath: string) => Promise<boolean> {
  const verdicts = new Map<string, Promise<boolean>>();
  return (appPath) => {
    const cached = verdicts.get(appPath);
    if (cached) return cached;
    const verdict = probe(appPath).catch((error) => {
      verdicts.delete(appPath);
      throw error;
    });
    verdicts.set(appPath, verdict);
    return verdict;
  };
}

const verifyDeveloperIdOnce = createSignatureVerifier();

export async function hasDeveloperIdSignature(
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  verify: (appPath: string) => boolean | Promise<boolean> = verifyDeveloperIdOnce,
): Promise<boolean> {
  if (platform !== "darwin") return true;
  const appPath = resolve(dirname(execPath), "../..");
  return verify(appPath);
}

export async function isAutoUpdateEligible(
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  verify?: (appPath: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  return isPackaged && (await hasDeveloperIdSignature(platform, execPath, verify));
}

// Wire the Electron-maintained update client. `notifyUser: false`
// replaces the stock modal with the in-app badge flow: `update-downloaded` is
// cached + pushed to the renderer (badge on the Rennet logo), and the renderer's
// confirm calls back on UPDATE_APPLY_CHANNEL to restart into the new version.
// "5 minutes" is the library's documented minimum interval.
//
// The whole thing is best-effort. On an unsigned / ad-hoc-signed macOS build
// Squirrel.Mac's autoUpdater rejects with an error (code signing is mandatory
// there). We catch the throw AND
// attach a quiet "error" listener so that degrades to a silent no-op instead of a
// crash or a nag dialog: no download ever completes, so no badge ever shows.
/** What `startAutoUpdate` hands back so the tray shares the SAME readiness + apply path. */
export interface AutoUpdateHandle {
  /** The live readiness store (also pushed to the renderer badge) — read `.ready` for state. */
  readonly readiness: UpdateReadiness;
  /** Prepare the bundle, then apply the staged update through quitAndInstall / stub respawn. */
  readonly applyUpdate: () => Promise<void>;
}

export interface AutoUpdateOptions {
  /** Platform-specific staged-update detection; injected by tests. */
  readonly detectStaged?: () => string | null;
  /** Release processes that execute from the app bundle before the installer replaces it. */
  readonly prepareToApply?: () => Promise<void>;
  /** Restore the daemon and window after the native installer rejects its handoff. */
  readonly recoverAfterApplyFailure?: () => Promise<void>;
  /** Arm an out-of-bundle relaunch before ShipIt replaces the running macOS app. */
  readonly armRelaunchAfterApply?: () => () => void;
  /** Surface an apply failure while the current app remains open. */
  readonly reportApplyFailure?: (message: string) => void;
}

type UpdatePhase = "idle" | "downloading" | "ready" | "applying";

export function startAutoUpdate(
  isTrustedUrl: (value: string) => boolean,
  logger: Console = console,
  options: AutoUpdateOptions = {},
): AutoUpdateHandle {
  const detectStaged =
    options.detectStaged ?? (() => stagedNewerVersion(process.execPath, app.getVersion()));
  const prepareToApply = options.prepareToApply ?? (async () => undefined);
  const recoverAfterApplyFailure = options.recoverAfterApplyFailure ?? (async () => undefined);
  const armRelaunchAfterApply = options.armRelaunchAfterApply ?? (() => () => undefined);
  const reportApplyFailure = options.reportApplyFailure ?? (() => undefined);
  let phase: UpdatePhase = "idle";
  let cancelRelaunchAfterApply: (() => void) | null = null;
  // Whether THIS run saw the live update-downloaded event. When readiness was
  // seeded from a previously staged update instead, electron's quitAndInstall
  // may no-op (its internal downloaded flag is unset), so apply falls back to
  // respawning the Squirrel stub - which always launches the newest staged
  // version - and quitting.
  let liveDownloadSeen = false;
  const readiness = createUpdateReadiness((info) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(UPDATE_READY_CHANNEL, info);
    }
  });

  const handleUpdaterError = async (error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[auto-update] updater error:", message);
    if (phase === "applying") {
      phase = readiness.ready ? "ready" : "idle";
      cancelRelaunchAfterApply?.();
      cancelRelaunchAfterApply = null;
      try {
        await recoverAfterApplyFailure();
      } catch (recoveryError) {
        const recoveryMessage =
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        reportApplyFailure(
          `${message}\n\nRennet also could not restore its local daemon: ${recoveryMessage}`,
        );
        return;
      }
      reportApplyFailure(message);
      return;
    }
    if (phase === "downloading") {
      phase = "idle";
      reportApplyFailure(message);
    }
  };

  // The one apply path, shared by the renderer badge's confirm AND the tray's
  // "Restart Rennet to update" line. The packaged daemon executes process.execPath from
  // inside Rennet.app; ShipIt cannot replace that bundle while the daemon is alive. Await the
  // injected release step before invoking either platform installer, and deduplicate a rapid
  // tray + renderer double-choice so two install handoffs can never race.
  let applyInFlight: Promise<void> | null = null;
  const applyUpdate = (): Promise<void> => {
    if (applyInFlight) return applyInFlight;
    const attempt = (async () => {
      try {
        await prepareToApply();
        phase = "applying";
        cancelRelaunchAfterApply = armRelaunchAfterApply();
        if (!liveDownloadSeen && process.platform === "win32") {
          const stub = resolve(dirname(process.execPath), "..", basename(process.execPath));
          if (existsSync(stub)) {
            spawn(stub, [], { detached: true, stdio: "ignore" }).unref();
            app.quit();
            return;
          }
        }
        autoUpdater.quitAndInstall();
        const handoffWatchdog = setTimeout(() => {
          if (phase !== "applying") return;
          void handleUpdaterError(
            new Error("The native updater closed Rennet without starting the install."),
          );
        }, APPLY_HANDOFF_TIMEOUT_MS);
        handoffWatchdog.unref?.();
      } catch (error) {
        if (phase === "applying") {
          await handleUpdaterError(error);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[auto-update] failed to prepare update:", message);
          reportApplyFailure(message);
        }
      }
    })();
    applyInFlight = attempt;
    void attempt.finally(() => {
      if (applyInFlight === attempt) applyInFlight = null;
    });
    return attempt;
  };

  // Replay for late subscribers: the preload invokes this once on load, so a
  // renderer that mounts (or reloads) after the download still badges.
  ipcMain.handle(UPDATE_READY_CHANNEL, (event) => {
    if (!event.senderFrame || !isTrustedUrl(event.senderFrame.url)) return null;
    return readiness.ready;
  });

  // The update NEVER applies without the user choosing it (spec) — this only
  // fires from the renderer's explicit confirm.
  ipcMain.on(UPDATE_APPLY_CHANNEL, (event) => {
    if (!event.senderFrame || !isTrustedUrl(event.senderFrame.url)) return;
    void applyUpdate();
  });

  autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
    liveDownloadSeen = true;
    phase = "ready";
    logger.error("[auto-update] update-downloaded:", releaseName);
    readiness.markDownloaded(releaseName);
  });
  autoUpdater.on("update-available", () => {
    phase = "downloading";
  });
  // The badge is a DISK FACT, not an event hope. Electron's live
  // `update-downloaded` was observed not firing on real Windows installs
  // (lancelot, 2026-08-19: stagings performed live by the running app produced
  // no event/badge, while every boot-seeded instance badged instantly). So the
  // staged-sibling state is polled on the same cadence as the update checks —
  // boot AND every 5 minutes — and readiness seeds whenever a newer version
  // appears. Idempotent: re-seeding fires only on a version CHANGE, so a
  // standing badge never re-broadcasts into churn. The live event above stays
  // wired as the fast path for whenever it does fire.
  let lastSeeded: string | null = null;
  const seedFromDisk = (): void => {
    const staged = detectStaged();
    if (staged && staged !== lastSeeded) {
      lastSeeded = staged;
      readiness.markDownloaded(staged);
    }
  };
  seedFromDisk();
  const stagedPoll = setInterval(seedFromDisk, STAGED_POLL_INTERVAL_MS);
  // Never hold the process open past app quit.
  stagedPoll.unref?.();
  autoUpdater.on("error", (error) => void handleUpdaterError(error));
  try {
    updateElectronApp({
      updateSource: updateSourceFor(process.platform, UPDATE_REPO),
      updateInterval: "5 minutes",
      notifyUser: false,
      logger,
    });
  } catch (error) {
    logger.error(
      "[auto-update] failed to initialise (ignored):",
      error instanceof Error ? error.message : error,
    );
  }
  return { readiness, applyUpdate };
}

const MAC_UPDATE_RELAUNCH_SCRIPT = `
parent_pid="$1"
app_path="$2"
running_version="$3"
opener="$4"

while /bin/kill -0 "$parent_pid" 2>/dev/null; do
  /bin/sleep 0.1
done

attempt=0
while [ "$attempt" -lt 600 ]; do
  installed_version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app_path/Contents/Info.plist" 2>/dev/null || true)
  if [ -n "$installed_version" ] && [ "$installed_version" != "$running_version" ]; then
    exec "$opener" "$app_path"
  fi
  attempt=$((attempt + 1))
  /bin/sleep 0.1
done

exec "$opener" "$app_path"
`;

export interface MacUpdateRelaunchOptions {
  readonly parentPid?: number;
  readonly openerPath?: string;
  readonly spawnProcess?: typeof spawn;
}

/**
 * ShipIt runs outside the app bundle while it replaces that bundle. This helper does too: it
 * waits for this Electron process to exit, then for the installed version to change, and opens
 * the installed app. The fallback open after 60 seconds also restores the previous version when
 * ShipIt exits without replacing it. Arguments stay positional so app paths never become shell.
 */
export function armMacUpdateRelaunch(
  appPath: string,
  runningVersion: string,
  options: MacUpdateRelaunchOptions = {},
): () => void {
  const child = (options.spawnProcess ?? spawn)(
    "/bin/sh",
    [
      "-c",
      MAC_UPDATE_RELAUNCH_SCRIPT,
      "rennet-update-relaunch",
      String(options.parentPid ?? process.pid),
      appPath,
      runningVersion,
      options.openerPath ?? "/usr/bin/open",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return () => {
    child.kill("SIGTERM");
  };
}

export function createAutoUpdateStarter(
  start: typeof startAutoUpdate = startAutoUpdate,
): typeof startAutoUpdate {
  let handle: AutoUpdateHandle | undefined;
  return (...args) => {
    handle ??= start(...args);
    return handle;
  };
}

export const startAutoUpdateOnce = createAutoUpdateStarter();
