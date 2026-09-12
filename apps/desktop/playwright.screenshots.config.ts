import { defineConfig } from "@playwright/test";

/**
 * The marketing screenshot capture (#470), kept OUT of the e2e suite: `playwright.config.ts`
 * matches `*.spec.ts`, this config matches only the capture file, and the marketing
 * project's uncached `screenshots` target is the one thing that runs it.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /marketing-screenshots\.capture\.ts/,
  timeout: 300_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
