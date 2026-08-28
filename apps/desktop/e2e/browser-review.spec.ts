import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addProject,
  completeWelcome,
  makeTempDir,
  modelFreeEnv,
  openDiffView,
  openWorkingTreeReview,
  seedReviewRepo,
} from "./harness";

// The browser shell journey (issue #381, design D7): a daemon started from the CLI serves
// the built browser UI over its HTTP port; a chromium tab loads it, connects back over WS
// to the SAME origin (a loopback tab is `private` — the full contract), and drives the
// local-review happy path end to end with NO Electron involved. The Electron specs and
// harness are untouched; this spec spawns and tears down its own daemon.

const RENNET_CLI = resolve("packages/server/dist/rennet.cjs");
const BROWSER_DIST = resolve("apps/desktop/dist/browser");

/** Poll the daemon's claim file for the bound port, up to `timeoutMs`. */
async function waitForPort(claimPath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { wsPort?: number };
      if (typeof claim.wsPort === "number") return claim.wsPort;
    } catch {
      // not written yet
    }
    if (Date.now() >= deadline) throw new Error(`daemon.json never carried a port at ${claimPath}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stopDaemon(child: ChildProcess, claimPath: string): Promise<void> {
  try {
    const pid = JSON.parse(readFileSync(claimPath, "utf8")).pid as number;
    if (typeof pid === "number") process.kill(pid, "SIGTERM");
  } catch {
    // no claim / already gone
  }
  child.kill("SIGTERM");
  if (await waitForExit(child, 3_000)) return;

  child.kill("SIGKILL");
  const killed = await waitForExit(child, 3_000);
  throw new Error(
    killed
      ? "daemon child did not exit within 3s of SIGTERM; escalated to SIGKILL"
      : "daemon child did not exit after SIGTERM and SIGKILL",
  );
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

test("adds a project and opens a review from a served browser tab", async ({ page }) => {
  test.skip(!existsSync(RENNET_CLI), `build the server CLI first (${RENNET_CLI} missing)`);
  test.skip(!existsSync(BROWSER_DIST), `build the browser bundle first (${BROWSER_DIST} missing)`);
  test.setTimeout(300_000);

  const repository = seedReviewRepo("rennet-e2e-browser-repo-");
  const userData = makeTempDir("rennet-e2e-browser-state-");
  const home = makeTempDir("rennet-e2e-browser-home-");
  const claimPath = join(userData, "daemon.json");

  const daemon = spawn(
    process.execPath,
    [RENNET_CLI, "serve", "--data-dir", userData, "--ui-dist", BROWSER_DIST],
    {
      env: { ...modelFreeEnv(home), RENNET_TEST_REPO: repository, RENNET_SERVER_VERSION: "e2e" },
      stdio: "ignore",
    },
  );

  try {
    const port = await waitForPort(claimPath, 15_000);

    await page.goto(`http://127.0.0.1:${port}/`);

    // The first-run welcome rendering proves the tab got the app AND connected over WS
    // (app.bootstrap resolved, `settings.get` and `projects.list` both answered) — with no
    // Electron in the picture. The tab's `window.rennet` carries no port, so the helper is
    // handed the served daemon's own.
    await expect(page.getByText("You stopped writing the code.")).toBeVisible({ timeout: 15_000 });
    await completeWelcome(page, port);
    await expect(page.locator('[data-screen="add-project-entry"]')).toBeVisible();

    // The add-a-project journey, model-free: the daemon serving this tab lists ITS OWN
    // filesystem into the in-app directory browser, so typing the fixture path is the whole
    // remote-path story — no native dialog and no path prompt anywhere.
    await addProject(page, repository);

    // Start a Review → the New Chat list built from the served daemon's real git → the
    // Current Checkout row captures the working tree into a review workspace, and the Diff
    // view renders the real patchset. The full journey, driven entirely from a browser tab.
    await openWorkingTreeReview(page);
    await openDiffView(page);
    await expect(
      page
        .getByRole("navigation", { name: "Changed files" })
        .getByRole("button", { name: /widget\.ts/ }),
    ).toBeVisible();
  } finally {
    try {
      await stopDaemon(daemon, claimPath);
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});
