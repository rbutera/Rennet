import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WsRennetBridge } from "@rennet/client";
import { completeWelcome, launchRennet, makeTempDir, seedReviewRepo } from "./harness";

// ─────────────────────────────────────────────────────────────────────────────
// The first-run welcome (C21), driven in the real app.
//
// This exists because of what fixing #574 revealed: the wizard broke every journey spec in
// the suite and the repair for all of them is `completeWelcome` — a helper whose whole job
// is to walk AROUND the wizard. Left there, C21's surface would ship with less e2e coverage
// than the screens it displaced, and nobody would notice until it broke something else. So
// the skip is paid for here: the wizard is driven, and the skip's own honesty is the last
// assertion in the file.
//
// Model-free like the rest of the suite (`RENNET_DISABLE_HARNESS=1`), so NO harness is detected
// here. That used to be what stopped the drive at Review setup; it is now the interesting case —
// the empty machine is precisely the one that was locked out, so this spec drives it through.
// ─────────────────────────────────────────────────────────────────────────────

test("the first-run welcome is what a first run gets, and completing it is what dismisses it", async () => {
  test.setTimeout(180_000);

  const repository = seedReviewRepo("rennet-e2e-welcome-repo-");
  const userData = makeTempDir("rennet-e2e-welcome-state-");
  const home = makeTempDir("rennet-e2e-welcome-home-");
  const { application } = await launchRennet({ repository, userData, home });

  try {
    const page = await application.firstWindow();

    // ── The wizard IS the first run, and the shell is not merely hidden behind it ──
    // `routes/app.tsx` unmounts the shell rather than hiding it: a mounted underlay still
    // registers coach anchors, and a coachmark portals to `document.body` — over the wizard,
    // burning an unseen mark on the next click. That decision is what made five journey specs
    // fail at once, so it is pinned here rather than rediscovered.
    await expect(
      page.getByText("You stopped writing the code. You still have to answer for it."),
    ).toBeVisible({ timeout: 60_000 });
    expect(await page.locator('[data-slot="corner-slot"]').count()).toBe(0);
    // No shell ⇒ no coach anchors ⇒ nothing for a coachmark to portal over the wizard from,
    // which is the whole reason C21 unmounts rather than hides. The mark itself is asserted
    // absent at unit level (`first-run-welcome.dom.test.tsx`); here the cause is what is pinned.
    expect(await page.locator("[data-screen]").count()).toBe(0);

    // ── Step 1 — Appearance. The choice is applied and PERSISTED as it is made, not on exit ──
    await page.getByRole("button", { name: "Continue to Rennet" }).click();
    await page
      .getByRole("radiogroup", { name: "Color scheme" })
      .getByRole("button", { name: "Dark" })
      .click();
    // An EXPLICIT dark resolves to dark whatever the host machine prefers, so this is the
    // one appearance assertion that is deterministic on any reviewer’s screen.
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");

    // ── Step 2 — Tools. Detection is DISCLOSED, never claimed: git is required and present,
    // and this environment's harnesses are switched off, so their rows say so. ──
    await page.getByRole("button", { name: /^Continue$/ }).click();
    await expect(page.getByText("Your tools, already connected.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Git", exact: true })).toBeVisible();

    // ── Step 3 — Review setup. The model-free environment detects no harness, so the honest
    // install path is what shows: an installation guide and a re-check, both real. ──
    await page.getByRole("button", { name: /^Continue$/ }).click();
    await expect(page.getByText("Choose how Rennet reviews.")).toBeVisible();
    await expect(page.getByText("Rennet couldn’t detect Claude Code or Codex.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
    // ── THE WALL IS GONE, and this is where that is proved in the real app ──
    // This block used to assert `toHaveCount(0)` on Continue: with nothing detected the step
    // offered no Continue at all, so a first run on a machine without Claude Code or Codex
    // could not finish the welcome, could not add a project, and could not reach the app —
    // by hand or from a test. That was ruled a Rule Zero violation and a release blocker.
    //
    // Rennet now DISCLOSES the missing harness and lets the reviewer through. The consequence
    // sentence is asserted because it is what REPLACED the wall: drop it silently and someone
    // lands in the app with no idea why review turns never run, which is worse than the wall
    // was — the wall at least explained itself.
    await expect(page.getByText(/can’t run review turns until one is installed/)).toBeVisible();
    const proceed = page.getByRole("button", { name: /^Continue$/ });
    await expect(proceed).toBeEnabled();

    // And it is a real exit, not merely a rendered button. This environment detects no harness
    // — the exact machine that was trapped — and the wizard still advances. A button existing
    // is not a button working, and only driving it proves which; `first-run-welcome.dom.test.tsx`
    // carries the same drive at unit level, all the way to New Chat.
    await proceed.click();
    await expect(page.getByText("Add the code you’re responsible for.")).toBeVisible();

    // The step chips are real navigation, not decoration: a completed step is revisitable and
    // the appearance chosen above survived the round trip.
    await page
      .getByRole("navigation", { name: "Welcome progress" })
      .getByText("Appearance")
      .click();
    // Step 1 replays its opening (the hero is the stage's entry, and the appearance card is
    // revealed by the arrow), so the arrow — not the card — is what proves we landed.
    await expect(page.getByRole("button", { name: "Continue to Rennet" })).toBeVisible();
    await page.getByRole("button", { name: "Continue to Rennet" }).click();
    await expect(page.getByText("Choose your appearance")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");

    // ── The skip's own honesty ──
    // Every other spec walks past this wizard with `settings.completeWelcome`. If that command
    // were not the real dismissal, those specs would be stepping around the welcome by some
    // side door and proving nothing about the app a user gets. So: run it, and the wizard is
    // gone, the shell is up, and the projects front door is what is behind it.
    await completeWelcome(page);
    await expect(page.locator('[data-screen="add-project-entry"]')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('[data-slot="corner-slot"]')).toBeVisible();
    await expect(
      page.getByText("You stopped writing the code. You still have to answer for it."),
    ).toHaveCount(0);

    // Persisted, not merely in this window's memory — the daemon carries the completion and
    // the appearance the wizard wrote, so a relaunch does not start over.
    const port = await page.evaluate(
      () => (window as unknown as { rennet: { wsPort: number } }).rennet.wsPort,
    );
    const bridge = new WsRennetBridge({ url: `ws://127.0.0.1:${port}`, autoReconnect: false });
    try {
      const settings = await bridge.invoke("settings.get", {});
      expect(settings.welcome?.completedAt).toBeTruthy();
      expect(settings.scheme).toBe("dark");
    } finally {
      bridge.close();
    }
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
