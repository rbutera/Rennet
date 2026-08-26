import type { Hunk, InvocationBudget, PatchFile } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import type { VerificationTurn, VerificationTurnResult } from "./finding-verification";
import { createInvocationBudget } from "./invocation-budget";
import {
  classifyUiSurface,
  isUiSurfacePath,
  runUiVerification,
  UI_SURFACE_CLASSIFIER_VERSION,
} from "./ui-verification";

function file(path: string): PatchFile {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false, patch: "" };
}

function hunk(id: string, filePath: string): Hunk {
  return {
    id,
    filePath,
    fileStatus: "modified",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    addedLines: ["<button>Go</button>"],
    deletedLines: [],
    contextLines: [],
    changedLoc: 1,
  };
}

describe("classifyUiSurface (#183) — the deterministic gate", () => {
  it("classifies component and stylesheet extensions as UI wherever they live", () => {
    for (const path of [
      "src/App.tsx",
      "web/Widget.jsx",
      "app/Page.vue",
      "ui/Card.svelte",
      "public/index.html",
      "styles/main.css",
      "styles/theme.scss",
      "styles/legacy.less",
    ]) {
      expect(isUiSurfacePath(path)).toBe(true);
    }
  });

  it("classifies a .ts/.js file as UI ONLY under a renderer/components/ui/app-ui path segment", () => {
    expect(isUiSurfacePath("packages/ui/src/tokens.ts")).toBe(true);
    // packages/app-ui is Rennet's composites package (renamed from packages/ui);
    // its .ts files under app-ui/ are UI surface too (regression: the rename must
    // not silently drop app-ui/*.ts from UI verification).
    expect(isUiSurfacePath("packages/app-ui/src/canvas/collation.ts")).toBe(true);
    expect(isUiSurfacePath("apps/desktop/src/renderer/store.ts")).toBe(true);
    expect(isUiSurfacePath("src/components/format.js")).toBe(true);
    // No UI segment ⇒ a plain script is NOT UI surface.
    expect(isUiSurfacePath("packages/core/src/pipeline.ts")).toBe(false);
    expect(isUiSurfacePath("scripts/build.js")).toBe(false);
    // A declaration file is never a rendered surface, even under a ui/ segment.
    expect(isUiSurfacePath("packages/ui/src/index.d.ts")).toBe(false);
  });

  it("reports touchesUi + the UI files, and a backend-only changeset as not touching UI", () => {
    const ui = classifyUiSurface([file("src/App.tsx"), file("packages/core/src/pipeline.ts")]);
    expect(ui.version).toBe(UI_SURFACE_CLASSIFIER_VERSION);
    expect(ui.touchesUi).toBe(true);
    expect(ui.files).toEqual(["src/App.tsx"]);

    const backend = classifyUiSurface([file("packages/core/src/pipeline.ts"), file("README.md")]);
    expect(backend.touchesUi).toBe(false);
    expect(backend.files).toEqual([]);
  });
});

const UI_FILES: PatchFile[] = [file("src/App.tsx")];
const HUNKS: Hunk[] = [hunk("h1", "src/App.tsx")];
const budget = (): InvocationBudget => createInvocationBudget(20);
const present = async (): Promise<{ status: "present" }> => ({ status: "present" });

describe("runUiVerification (#183) — the ladder", () => {
  it("not-ui: a backend-only changeset spends nothing and records the distinct status", async () => {
    const runTurn = vi.fn();
    const result = await runUiVerification({
      files: [file("packages/core/src/pipeline.ts")],
      hunks: [],
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn: runTurn as unknown as VerificationTurn,
    });
    expect(result.status).toEqual({
      status: "not-ui",
      classifierVersion: UI_SURFACE_CLASSIFIER_VERSION,
    });
    expect(result.observations).toEqual([]);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("unavailable: an absent verifier is disclosed, never a clear", async () => {
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
    });
    expect(result.status.status).toBe("unavailable");
    if (result.status.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.status.reason).toMatch(/no verifier/i);
  });

  it("unavailable: an exhausted budget is disclosed with the budget reason, no turn runs", async () => {
    const spent: InvocationBudget = createInvocationBudget(0);
    const runTurn = vi.fn();
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: spent,
      inspectEvidence: present,
      runTurn: runTurn as unknown as VerificationTurn,
    });
    expect(result.status.status).toBe("unavailable");
    if (result.status.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.status.reason).toMatch(/budget/i);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("could-not-mount: a turn that mounted nothing yields the inconclusive disclosure carrying what it attempted", async () => {
    const runTurn: VerificationTurn = vi.fn(
      async (): Promise<VerificationTurnResult> => ({
        status: "emitted",
        body: {
          mounted: false,
          method: "none",
          attempted: "no test harness, no storybook, no dev server",
          screenshots: [],
          observations: [],
        },
      }),
    );
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn,
    });
    expect(result.status.status).toBe("unavailable");
    if (result.status.status !== "unavailable") throw new Error("expected unavailable");
    // The disclosure carries what was attempted — never "no UI problems found".
    expect(result.status.reason).toMatch(/no test harness/);
    expect(result.observations).toEqual([]);
  });

  it("a failed turn maps to unavailable with the turn reason (never a fabricated clear)", async () => {
    const runTurn: VerificationTurn = vi.fn(
      async (): Promise<VerificationTurnResult> => ({
        status: "failed",
        message: "the harness crashed",
      }),
    );
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn,
    });
    expect(result.status.status).toBe("unavailable");
    if (result.status.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.status.reason).toMatch(/harness crashed/);
  });

  it("ran + execution-backed: a mounted run yields reproduced findings and a ran status with screenshots", async () => {
    const runTurn: VerificationTurn = vi.fn(
      async (): Promise<VerificationTurnResult> => ({
        status: "emitted",
        body: {
          mounted: true,
          method: "storybook",
          attempted: "storybook",
          screenshots: [{ path: "app.png", label: "App, default" }],
          observations: [
            {
              file: "src/App.tsx",
              line: 12,
              impact: "high",
              summary: "the submit button has no accessible name",
              evidence: "axe: button-name violation on <button>",
            },
          ],
        },
        execution: { commands: [{ command: "pnpm storybook", ok: true, outputTail: "ready" }] },
      }),
    );
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn,
    });
    expect(result.status).toEqual({
      status: "ran",
      classifierVersion: UI_SURFACE_CLASSIFIER_VERSION,
      screenshots: [{ path: "app.png", label: "App, default" }],
      observationCount: 1,
      mounted: true,
    });
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0];
    expect(observation?.severity).toBe("high");
    expect(observation?.anchor).toBe("rennet:hunk/h1");
    expect(observation?.agreement).toEqual({ kind: "concur", agree: 1, total: 1 });
    expect(observation?.verification?.verdict).toBe("reproduced");
  });

  it("ran but static (no observed exec): findings are inconclusive, mounted is false", async () => {
    const runTurn: VerificationTurn = vi.fn(
      async (): Promise<VerificationTurnResult> => ({
        status: "emitted",
        body: {
          mounted: true,
          method: "static",
          attempted: "static markup review",
          screenshots: [],
          observations: [
            {
              file: "src/App.tsx",
              impact: "medium",
              summary: "the heading order skips h2",
              evidence: "",
            },
          ],
        },
      }),
    );
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn,
    });
    if (result.status.status !== "ran") throw new Error("expected ran");
    expect(result.status.mounted).toBe(false);
    expect(result.observations[0]?.verification?.verdict).toBe("inconclusive");
    // An empty evidence string falls back to the honest static caveat, never blank.
    expect(result.observations[0]?.verification?.evidence.length).toBeGreaterThan(0);
  });

  it("does not certify a mount when the structured method is static", async () => {
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn: async () => ({
        status: "emitted",
        body: {
          mounted: true,
          method: "static",
          attempted: "static review",
          screenshots: [{ path: "app.png", label: "App" }],
          observations: [
            {
              file: "src/App.tsx",
              impact: "medium",
              summary: "contrast is low",
              evidence: "visual inspection",
            },
          ],
        },
        execution: { commands: [{ command: "pnpm storybook", ok: true, outputTail: "ready" }] },
      }),
    });
    if (result.status.status !== "ran") throw new Error("expected ran");
    expect(result.status.mounted).toBe(false);
    expect(result.observations[0]?.verification?.verdict).toBe("inconclusive");
  });

  it("does not certify a mount from an unrelated successful exec", async () => {
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn: async () => ({
        status: "emitted",
        body: {
          mounted: true,
          method: "storybook",
          attempted: "storybook",
          screenshots: [{ path: "app.png", label: "App" }],
          observations: [
            {
              file: "src/App.tsx",
              impact: "medium",
              summary: "contrast is low",
              evidence: "visual inspection",
            },
          ],
        },
        execution: { commands: [{ command: "echo ready", ok: true, outputTail: "ready" }] },
      }),
    });
    if (result.status.status !== "ran") throw new Error("expected ran");
    expect(result.status.mounted).toBe(false);
    expect(result.observations[0]?.verification?.verdict).toBe("inconclusive");
  });

  it("does not certify a mount when the claimed screenshot is not present", async () => {
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: async () => ({ status: "not-found" }),
      runTurn: async () => ({
        status: "emitted",
        body: {
          mounted: true,
          method: "storybook",
          attempted: "storybook",
          screenshots: [{ path: "missing.png", label: "App" }],
          observations: [
            {
              file: "src/App.tsx",
              impact: "medium",
              summary: "contrast is low",
              evidence: "visual inspection",
            },
          ],
        },
        execution: { commands: [{ command: "pnpm storybook", ok: true, outputTail: "ready" }] },
      }),
    });
    if (result.status.status !== "ran") throw new Error("expected ran");
    expect(result.status.mounted).toBe(false);
    expect(result.status.screenshots).toEqual([]);
    expect(result.observations[0]?.verification?.verdict).toBe("inconclusive");
  });

  it("anchors an observation to the containing or nearest hunk for its reported line", async () => {
    const second = { ...hunk("h2", "src/App.tsx"), newStart: 100, newLines: 10 };
    const first = { ...hunk("h1", "src/App.tsx"), newStart: 10, newLines: 5 };
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: [first, second],
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn: async () => ({
        status: "emitted",
        body: {
          mounted: true,
          method: "tests",
          attempted: "component tests",
          screenshots: [{ path: "app.png", label: "App" }],
          observations: [
            {
              file: "src/App.tsx",
              line: 105,
              impact: "high",
              summary: "the dialog is clipped",
              evidence: "rendered at line 105",
            },
          ],
        },
        execution: { commands: [{ command: "pnpm test", ok: true, outputTail: "passed" }] },
      }),
    });
    expect(result.observations[0]?.anchor).toBe("rennet:hunk/h2");
  });

  it("drops observations for files outside the classified UI set", async () => {
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: present,
      runTurn: async () => ({
        status: "emitted",
        body: {
          mounted: false,
          method: "static",
          attempted: "static review",
          screenshots: [{ path: "app.png", label: "App" }],
          observations: [
            {
              file: "packages/core/src/secret.ts",
              impact: "high",
              summary: "not a UI file",
              evidence: "unrelated",
            },
          ],
        },
      }),
    });
    expect(result.observations).toEqual([]);
  });

  it("bounds screenshot references and filesystem checks per run", async () => {
    const inspectEvidence = vi.fn(present);
    const screenshots = Array.from({ length: 13 }, (_, index) => ({
      path: `${index}.png`,
      label: `shot ${index}`,
    }));
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence,
      runTurn: async () => ({
        status: "emitted",
        body: {
          mounted: false,
          method: "static",
          attempted: "static review",
          screenshots,
          observations: [],
        },
      }),
    });
    if (result.status.status !== "ran") throw new Error("expected ran");
    expect(result.status.screenshots).toHaveLength(12);
    expect(inspectEvidence).toHaveBeenCalledTimes(12);
  });

  it("reports an oversized-only capture as unavailable rather than a mounted clear", async () => {
    const result = await runUiVerification({
      files: UI_FILES,
      hunks: HUNKS,
      evidenceDir: "/ev",
      budget: budget(),
      inspectEvidence: async () => ({ status: "oversized" }),
      runTurn: async () => ({
        status: "emitted",
        body: {
          mounted: true,
          method: "storybook",
          attempted: "storybook",
          screenshots: [{ path: "huge.png", label: "Huge" }],
          observations: [],
        },
        execution: { commands: [{ command: "pnpm storybook", ok: true, outputTail: "ready" }] },
      }),
    });
    expect(result.status.status).toBe("unavailable");
    if (result.status.status !== "unavailable") throw new Error("expected unavailable");
    expect(result.status.reason).toContain("8 MiB");
  });
});
