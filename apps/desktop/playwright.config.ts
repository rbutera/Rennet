import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  // Two shells, two projects over the shared testDir (issue #381, design D7). The Electron
  // specs launch `_electron` themselves and use no browser fixture, so they stay in a
  // project with no `use` — untouched. The browser spec runs in a chromium project.
  projects: [
    { name: "electron", testIgnore: /browser-review\.spec\.ts/ },
    {
      name: "browser",
      testMatch: /browser-review\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
