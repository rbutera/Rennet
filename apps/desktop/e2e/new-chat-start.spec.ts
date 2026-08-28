import { rmSync } from "node:fs";
import { basename } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { git, initRepo, launchRennet, makeTempDir, writeRepoFile } from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// #587 — clicking a row in New Chat STARTS THE REVIEW, driven on the real app.
//
// The bug this closes was invisible to every unit test that mounted the surface: the
// click really did mint a durable session and really did claim the branch, so the
// surface looked correct — but nothing captured what CHANGED on that branch, so the
// route landed on the chat-only session and the reviewer had nothing to review.
//
// So the proof is the shipped Electron app, driven per row kind: the real add flow,
// the real New Chat list built from real git, a real click, and then the real daemon
// asked what it now holds. Deterministic and model-free — no harness turn runs — so
// it stays in the free suite. The PR row is the one kind that cannot be driven here
// (it needs a GitHub PR and an authenticated forge); its capture is `review.openPr`,
// already shipped, and the only #587 addition to it is the `sessionId` attach that
// the branch and checkout rows below both exercise.
// ─────────────────────────────────────────────────────────────────────────────

interface Daemon {
  /** Mark the first-run welcome done. This spec is about the NEW CHAT front door; the
   *  welcome wizard in front of it is another surface's subject, so it is settled through
   *  the app's own command rather than re-driven here. */
  completeWelcome: () => Promise<void>;
  sessions: () => Promise<
    { id: string; title: string; reviewId?: string; claim?: { branch: string } }[]
  >;
  review: (id: string) => Promise<{ source?: string; files: { path: string }[] }>;
  close: () => void;
}

/** A bridge onto the app's OWN daemon — the same socket the renderer talks to. Used to
 *  ASK what the click produced, never to produce it. */
async function daemonOf(page: Page): Promise<Daemon> {
  const port = await page.evaluate(
    () => (window as unknown as { rennet: { wsPort: number } }).rennet.wsPort,
  );
  const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
  return {
    completeWelcome: async () => {
      await bridge.invoke("settings.completeWelcome", {});
    },
    sessions: async () => (await bridge.invoke("session.list", {})).sessions,
    review: async (id) => {
      const { review } = await bridge.invoke("review.load", {
        commandId: crypto.randomUUID(),
        reviewId: id,
      });
      const active = review.patchsets.find((p) => p.id === review.activePatchsetId);
      return { source: active?.source, files: active?.files ?? [] };
    },
    close: () => bridge.close(),
  };
}

/**
 * A repo with one row of every locally-drivable kind:
 *   • `feat/committed` — a branch with its own commit (the branch-review row);
 *   • `already-merged` — a branch pointing AT main, so its range is empty;
 *   • the checked-out `feature/widget` with an uncommitted edit (the checkout row).
 */
function seedRowRepo(): string {
  const repository = makeTempDir("rennet-e2e-587-repo-");
  initRepo(repository);
  writeRepoFile(repository, "src/widget.ts", "export const widget = 1;\n");
  git(repository, "add", "src/widget.ts");
  git(repository, "commit", "-qm", "initial");

  git(repository, "checkout", "-qb", "feat/committed");
  writeRepoFile(repository, "src/branch-only.ts", "export const branchOnly = true;\n");
  git(repository, "add", "src/branch-only.ts");
  git(repository, "commit", "-qm", "branch: add branch-only");

  git(repository, "checkout", "-q", "main");
  // No unique commits: merge-base(main, already-merged) IS its head.
  git(repository, "branch", "already-merged");

  git(repository, "checkout", "-qb", "feature/widget");
  writeRepoFile(repository, "src/widget.ts", "export const widget = 2;\n");
  return repository;
}

/** The real add-a-project journey, ending on the indexing screen's "Start a Review". */
async function addProjectAndOpenNewChat(page: Page, repository: string): Promise<void> {
  await page.getByRole("button", { name: "Add Project" }).first().click();
  const pathBar = page.getByRole("textbox", { name: "Directory path" });
  // The browser loads its opening directory asynchronously and writes the result BACK into
  // the path bar (`directory-browser.tsx`: `setTyped(result.path)` in the load handler), so a
  // fill that lands before that first load resolves is silently overwritten and Enter then
  // re-navigates to the daemon's home. The breadcrumb renders only once `path !== null`, so
  // it is the signal that the opening load has settled and the bar is ours to type into.
  await expect(page.getByRole("navigation", { name: "Current path" })).toBeVisible();
  await pathBar.fill(repository);
  await pathBar.press("Enter");
  await expect(page.getByRole("button", { name: basename(repository), exact: true })).toBeVisible();
  const add = page.getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.locator('[data-screen="project-indexing"]')).toBeVisible({ timeout: 60_000 });
  const startReview = page.getByRole("button", { name: "Start a Review" });
  await expect(startReview).toBeVisible({ timeout: 180_000 });
  await startReview.click();
  await expect(page.locator('[data-screen="new-chat"]')).toBeVisible();
}

/** Back to the same project's New Chat after a start landed on a session. */
async function backToNewChat(page: Page): Promise<void> {
  const hash = await page.evaluate(() => location.hash);
  await page.goBack();
  // A history step that did not leave the session (the mint replaced nothing) is retried
  // once through the sidebar's New-chat entry rather than guessing a project id.
  if ((await page.evaluate(() => location.hash)) === hash) {
    await page
      .getByRole("button", { name: /New chat/i })
      .first()
      .click();
  }
  await expect(page.locator('[data-screen="new-chat"]')).toBeVisible({ timeout: 30_000 });
}

/**
 * Click a row and hold the app to the whole act: it left New Chat, it landed on a
 * session route, and that route is the REVIEW workspace — not the chat-only session,
 * which is precisely what the bug produced.
 */
async function clickRowAndLand(page: Page, name: RegExp): Promise<void> {
  await page.locator('[data-row="target"]', { hasText: name }).first().click();
  await expect(page.getByText(/^REVIEW ·/)).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('[data-screen="chat-only-session"]')).toHaveCount(0);
  expect(await page.evaluate(() => location.hash)).toMatch(/#\/s\//);
}

test("#587: every New Chat row kind starts a real review of that target", async () => {
  test.setTimeout(600_000);
  const repository = seedRowRepo();
  const userData = makeTempDir("rennet-e2e-587-state-");
  const home = makeTempDir("rennet-e2e-587-home-");
  const { application } = await launchRennet({ repository, userData, home });
  let daemon: Daemon | undefined;
  try {
    const page = await application.firstWindow();
    daemon = await daemonOf(page);
    await daemon.completeWelcome();
    await page.reload();
    await addProjectAndOpenNewChat(page, repository);

    // ── ROW KIND 1: a local branch with its own commits ───────────────────────
    await clickRowAndLand(page, /feat\/committed/);
    const afterBranch = await daemon.sessions();
    const branchSession = afterBranch.find((s) => s.claim?.branch === "feat/committed");
    expect(branchSession?.reviewId).toBeTruthy();
    const branchReview = await daemon.review(branchSession?.reviewId ?? "");
    // The branch's OWN commit is what was captured — a range against the merge-base,
    // taken without checking the branch out (the app is still on `feature/widget`).
    expect(branchReview.files.map((f) => f.path)).toContain("src/branch-only.ts");
    // A snapshot, not a working-tree capture: `local` would hand Regenerate a licence to
    // replace the reviewed range with a capture of this clone's tree.
    expect(branchReview.source).toBe("local-branch");

    // ── ROW KIND 2: the Current Checkout row (no target) ──────────────────────
    await backToNewChat(page);
    await clickRowAndLand(page, /Current Checkout/);
    const afterCheckout = await daemon.sessions();
    const checkoutSession = afterCheckout.find((s) => s.claim === undefined);
    expect(checkoutSession?.reviewId).toBeTruthy();
    const checkoutReview = await daemon.review(checkoutSession?.reviewId ?? "");
    // The working tree's uncommitted edit — today's capture, unchanged.
    expect(checkoutReview.files.map((f) => f.path)).toContain("src/widget.ts");
    expect(checkoutReview.source ?? "local").toBe("local");

    // ── THE EMPTY CASE: a branch with no unique commits ───────────────────────
    // The bitter way to close this issue would be to reproduce its own defect here: a
    // click that appears to do nothing. An empty range is an EMPTY REVIEW, and the
    // reviewer still lands on it.
    await backToNewChat(page);
    await clickRowAndLand(page, /already-merged/);
    const afterEmpty = await daemon.sessions();
    const emptySession = afterEmpty.find((s) => s.claim?.branch === "already-merged");
    expect(emptySession?.reviewId).toBeTruthy();
    expect((await daemon.review(emptySession?.reviewId ?? "")).files).toEqual([]);
  } finally {
    daemon?.close();
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
