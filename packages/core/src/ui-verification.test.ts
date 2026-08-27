import type { PatchFile } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  classifyUiSurface,
  isUiSurfacePath,
  UI_SURFACE_CLASSIFIER_VERSION,
} from "./ui-verification";

function file(path: string): PatchFile {
  return { path, status: "modified", additions: 1, deletions: 0, binary: false, patch: "" };
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
