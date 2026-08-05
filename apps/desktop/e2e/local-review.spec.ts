import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;

function git(root: string, ...arguments_: string[]): void {
  execFileSync("git", arguments_, { cwd: root, stdio: "ignore" });
}

test("captures a repository in a hardened renderer and invalidates safely", async () => {
  const repository = mkdtempSync(join(tmpdir(), "rennet-e2e-repo-"));
  const userData = mkdtempSync(join(tmpdir(), "rennet-e2e-state-"));
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.email", "rennet@example.test");
  git(repository, "config", "user.name", "Rennet Test");
  writeFileSync(join(repository, "review-me.ts"), "export const value = 1;\n");
  git(repository, "add", "review-me.ts");
  git(repository, "commit", "-qm", "initial");
  git(repository, "checkout", "-qb", "feature/review-me");
  writeFileSync(join(repository, "review-me.ts"), "export const value = 2;\n");

  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [resolve("apps/desktop")],
    env: { ...process.env, RENNET_TEST_REPO: repository, RENNET_USER_DATA: userData },
  });

  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Review the code you actually have." }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        process: typeof (globalThis as unknown as { process?: unknown }).process,
        bridge: Object.keys((globalThis as typeof globalThis & { rennet: object }).rennet),
      })),
    ).toEqual({ process: "undefined", bridge: ["invoke"] });

    await page.getByRole("button", { name: "Choose a repository" }).click();
    await expect(page.getByRole("button", { name: /review-me\.ts/ })).toBeVisible();
    await expect(page.locator("pre.diff")).toContainText("export const value = 2;");

    writeFileSync(join(repository, "review-me.ts"), "export const value = 3;\n");
    await expect(page.getByText("Your code changed.")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("pre.diff")).toContainText("export const value = 2;");
    await page.getByRole("button", { name: "Regenerate affected review" }).click();
    await expect(page.locator("pre.diff")).toContainText("export const value = 3;");
  } finally {
    await application.close();
    rmSync(repository, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});
