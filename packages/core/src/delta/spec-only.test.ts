import { describe, expect, it } from "vitest";
import { isSpecArtifactPath, isSpecOnlyChange } from "./spec-only";

/**
 * PR #918's exact inventory (`spec/workspace-settings`, 2026-09-08): an OpenSpec change
 * proposed ahead of its code, plus the `openspec/changes/README.md` index beside it. This is
 * the branch on which every non-Design seat was dispatched to review no code at all, which
 * is the sighting this predicate answers — so the fixture is the sighting, not a tidier one.
 */
const PR_918_FILES = [
  "openspec/changes/README.md",
  "openspec/changes/workspace-settings/.openspec.yaml",
  "openspec/changes/workspace-settings/design.md",
  "openspec/changes/workspace-settings/proposal.md",
  "openspec/changes/workspace-settings/specs/session-bound-workspace/spec.md",
  "openspec/changes/workspace-settings/specs/settings-resolution/spec.md",
  "openspec/changes/workspace-settings/specs/workspace-inventory/spec.md",
  "openspec/changes/workspace-settings/tasks.md",
].map((path) => ({ path }));

describe("isSpecOnlyChange", () => {
  it("is true for an OpenSpec-only branch, README index included (PR #918)", () => {
    expect(isSpecOnlyChange(PR_918_FILES)).toBe(true);
  });

  it("is false the moment one changed path is not a specification artifact", () => {
    // The positive control for the fixture above: the same rows plus one source file.
    expect(isSpecOnlyChange([...PR_918_FILES, { path: "packages/core/src/settings.ts" }])).toBe(
      false,
    );
    // A test file, a lockfile, a package manifest: none of them is a specification.
    expect(isSpecOnlyChange([{ path: "packages/core/src/settings.test.ts" }])).toBe(false);
    expect(isSpecOnlyChange([{ path: "pnpm-lock.yaml" }])).toBe(false);
    expect(isSpecOnlyChange([{ path: "package.json" }])).toBe(false);
  });

  it("is false for an empty inventory — nothing to render is not spec-only", () => {
    expect(isSpecOnlyChange([])).toBe(false);
  });

  it("reads a rename's OLD side too: a file moved out of a spec directory is a code change", () => {
    expect(
      isSpecOnlyChange([{ path: "openspec/specs/auth/spec.md", previousPath: "src/auth.md" }]),
    ).toBe(false);
    expect(
      isSpecOnlyChange([
        {
          path: "openspec/changes/beta/proposal.md",
          previousPath: "openspec/changes/alpha/proposal.md",
        },
      ]),
    ).toBe(true);
  });

  it("is false for a docs-only or README-only branch — prose the Design lens does not read", () => {
    expect(isSpecOnlyChange([{ path: "README.md" }])).toBe(false);
    expect(isSpecOnlyChange([{ path: "docs/using/concepts/product-and-vision.md" }])).toBe(false);
  });
});

describe("isSpecArtifactPath", () => {
  it("accepts every root the Design readers select on", () => {
    for (const path of [
      "openspec/changes/README.md",
      "openspec/specs/auth/spec.md",
      ".kiro/specs/login/requirements.md",
      ".bmad/prd.md",
      ".bmad-core/core-config.yaml",
      "docs/superpowers/specs/feature.md",
      "docs/superpowers/plans/2026-09-01-feature.md",
      ".superpowers/sdd/feature/progress.md",
      "docs/adr/0003-foo.md",
      "docs/decisions/0004-bar.md",
      "src/billing/docs/adr/0001-context-local.md",
      "CONTEXT.md",
      "src/billing/CONTEXT.md",
      "CONTEXT-MAP.md",
    ]) {
      expect(isSpecArtifactPath(path), path).toBe(true);
    }
  });

  it("refuses look-alikes: a stray `mydocs/adr/`, a non-Markdown ADR, an `openspec` file at the root", () => {
    expect(isSpecArtifactPath("mydocs/adr/0001.md")).toBe(false);
    expect(isSpecArtifactPath("docs/adr/diagram.png")).toBe(false);
    expect(isSpecArtifactPath("openspec.md")).toBe(false);
    expect(isSpecArtifactPath("src/context.ts")).toBe(false);
  });

  it("normalises Windows separators and a leading `./`", () => {
    expect(isSpecArtifactPath("openspec\\changes\\x\\proposal.md")).toBe(true);
    expect(isSpecArtifactPath("./docs/adr/0001.md")).toBe(true);
  });
});
