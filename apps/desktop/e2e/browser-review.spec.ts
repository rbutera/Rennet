import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { makeTempDir, modelFreeEnv, seedReviewRepo } from "./harness";

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
  test.setTimeout(120_000);

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

    // The front door rendering proves the tab got the app AND connected over WS
    // (app.bootstrap resolved) — with no Electron in the picture.
    await expect(page.getByRole("heading", { name: "Rennet" })).toBeVisible({ timeout: 15_000 });

    // The add-a-project journey (mirrors the passing Electron add-project spec), model-free.
    // The in-app directory browser replaced the remote path prompt: type the fixture path into
    // the browser's path bar (the served daemon lists its own filesystem), then continue.
    await page.getByRole("button", { name: "Add a project" }).click();
    await page.getByRole("button", { name: /Project repo/ }).click();
    const pathBar = page.getByRole("textbox", { name: "Directory path" });
    await pathBar.fill(repository);
    await pathBar.press("Enter");
    await expect(
      page.getByRole("button", { name: basename(repository), exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByText(/^Found in/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.locator(".processing")).toBeVisible();
    const openProject = page.getByRole("button", { name: /^Open / });
    await expect(openProject).toBeVisible({ timeout: 60_000 });
    await openProject.click();

    await expect(page.locator(".project-detail")).toBeVisible();
    const rows = page.locator(".smart-row");
    await expect(rows.first()).toBeVisible();

    // Opening a row captures the working tree into a review workspace — the full journey,
    // driven entirely from the browser tab.
    await rows.first().locator(".smart-row-open").click();
    await expect(page.getByRole("tab", { name: "Canvases" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
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
