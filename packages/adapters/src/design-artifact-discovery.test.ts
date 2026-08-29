import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Patchset, PatchsetIntentSurface } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESIGN_ARTIFACT_LIMITS,
  type DesignArtifactFormat,
  type DesignArtifactRole,
  discoverDesignArtifacts,
} from "./design-artifact-discovery";
import { execaGit } from "./git-range-diff";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function repository(files: Readonly<Record<string, string>>): { root: string; headOid: string } {
  const root = mkdtempSync(join(tmpdir(), "rennet-design-discovery-"));
  tempRoots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@rennet.dev");
  git(root, "config", "user.name", "Rennet Test");
  writeFiles(root, files);
  git(root, "add", "-f", "--all");
  git(root, "commit", "-qm", "fixture");
  return { root, headOid: git(root, "rev-parse", "HEAD").trim() };
}

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
}

function patchsetOf(options: {
  readonly root: string;
  readonly headOid: string;
  readonly paths: readonly string[];
  readonly surface: PatchsetIntentSurface;
  readonly source?: NonNullable<Patchset["source"]>;
}): Patchset {
  return {
    id: "patchset-1",
    createdAt: "2026-08-29T00:00:00Z",
    repository: {
      id: "repo-1",
      root: options.root,
      commonDir: join(options.root, ".git"),
      baseRef: "main",
      baseOid: options.headOid,
      headOid: options.headOid,
    },
    files: options.paths.map((path) => ({
      path,
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
      patch: "",
    })),
    rawDiff: "",
    byteLength: 0,
    truncated: false,
    source: options.source ?? (options.surface === "working-tree" ? "local" : "github-local"),
    intent: { surface: options.surface },
  };
}

interface FamilyCase {
  readonly label: string;
  readonly format: DesignArtifactFormat;
  readonly files: Readonly<Record<string, string>>;
  readonly expectedCandidates: readonly {
    readonly name: string;
    readonly artifacts: readonly { readonly path: string; readonly role: DesignArtifactRole }[];
  }[];
}

const familyCases: readonly FamilyCase[] = [
  {
    label: "OpenSpec change",
    format: "openspec",
    files: {
      "openspec/changes/add-search/proposal.md": "# Add search\n\n## Why\n\nFind records.\n",
      "openspec/changes/add-search/specs/search/spec.md":
        "## ADDED Requirements\n\n### Requirement: Search\n\nSearch SHALL work.\n",
      "openspec/changes/add-search/tasks.md": "# Tasks\n\n- [ ] 1.1 Build search\n",
    },
    expectedCandidates: [
      {
        name: "add-search",
        artifacts: [
          { path: "openspec/changes/add-search/proposal.md", role: "proposal" },
          { path: "openspec/changes/add-search/specs/search/spec.md", role: "spec-delta" },
          { path: "openspec/changes/add-search/tasks.md", role: "tasks" },
        ],
      },
    ],
  },
  {
    label: "Kiro feature triplet and bugfix",
    format: "kiro",
    files: {
      ".kiro/specs/account/requirements.md": "# Requirements Document\n\n### Requirement 1\n",
      ".kiro/specs/account/design.md": "# Design\n\n## Architecture\n\nAccount service.\n",
      ".kiro/specs/account/tasks.md": "# Implementation Plan\n\n- [ ] 1. Account\n",
      ".kiro/specs/session-fix/bugfix.md": "# Session bugfix\n\n## Expected Behavior\n\nPersist.\n",
      ".kiro/specs/session-fix/design.md": "# Fix design\n",
      ".kiro/specs/session-fix/tasks.md": "# Tasks\n\n- [ ] Fix it\n",
    },
    expectedCandidates: [
      {
        name: "account",
        artifacts: [
          { path: ".kiro/specs/account/requirements.md", role: "requirements" },
          { path: ".kiro/specs/account/design.md", role: "design" },
          { path: ".kiro/specs/account/tasks.md", role: "tasks" },
        ],
      },
      {
        name: "session-fix",
        artifacts: [
          { path: ".kiro/specs/session-fix/bugfix.md", role: "bugfix" },
          { path: ".kiro/specs/session-fix/design.md", role: "design" },
          { path: ".kiro/specs/session-fix/tasks.md", role: "tasks" },
        ],
      },
    ],
  },
  {
    label: "BMAD configured chain",
    format: "bmad",
    files: {
      ".bmad-core/core-config.yaml": [
        "prd:",
        "  prdFile: planning/prd.md",
        "  prdSharded: true",
        "  prdShardedLocation: planning/epics",
        "  epicFilePattern: epic-{n}*.md",
        "architecture:",
        "  architectureFile: planning/architecture.md",
        "  architectureSharded: true",
        "  architectureShardedLocation: planning/architecture",
        "devStoryLocation: planning/stories",
      ].join("\n"),
      "planning/prd.md": "# Product\n\n## Requirements\n\nFR1: Work.\n",
      "planning/epics/epic-1-foundation.md": "# Epic 1\n",
      "planning/architecture.md": "# Architecture\n",
      "planning/architecture/tech-stack.md": "# Tech Stack\n",
      "planning/stories/1.1.story.md": "# Story 1.1\n\n## Status\n\nDraft\n",
    },
    expectedCandidates: [
      {
        name: "Product",
        artifacts: [
          { path: "planning/prd.md", role: "prd" },
          { path: "planning/architecture.md", role: "architecture" },
          { path: "planning/architecture/tech-stack.md", role: "architecture" },
          { path: "planning/epics/epic-1-foundation.md", role: "epic" },
          { path: "planning/stories/1.1.story.md", role: "story" },
        ],
      },
    ],
  },
  {
    label: "Superpowers spec, plan, and progress",
    format: "superpowers",
    files: {
      "docs/superpowers/specs/2026-08-29-search-design.md": [
        "# Search design",
        "",
        "## Architecture",
        "",
        "## Components",
        "",
        "## Data flow",
        "",
        "## Error handling",
        "",
        "## Testing",
      ].join("\n"),
      "docs/superpowers/plans/2026-08-29-search.md": [
        "# Search Implementation Plan",
        "",
        "**Goal:** Add search",
        "",
        "**Architecture:** Index records",
        "",
        "**Spec:** `docs/superpowers/specs/2026-08-29-search-design.md`",
        "",
        "### Task 1: Index",
        "",
        "- [ ] Build it",
      ].join("\n"),
      ".superpowers/sdd/2026-08-29-search/progress.md":
        "# SDD ledger — plan: docs/superpowers/plans/2026-08-29-search.md\n",
    },
    expectedCandidates: [
      {
        name: "Search",
        artifacts: [
          { path: "docs/superpowers/specs/2026-08-29-search-design.md", role: "design" },
          { path: "docs/superpowers/plans/2026-08-29-search.md", role: "plan" },
          { path: ".superpowers/sdd/2026-08-29-search/progress.md", role: "progress" },
        ],
      },
    ],
  },
  {
    label: "CONTEXT map, glossaries, and ADRs",
    format: "grill-with-docs",
    files: {
      "CONTEXT-MAP.md":
        "# Commerce contexts\n\n## Contexts\n\n- [Ordering](src/ordering/CONTEXT.md)\n",
      "src/ordering/CONTEXT.md":
        "# Ordering\n\n## Language\n\n**Order**:\nA request for goods.\n_Avoid_: Purchase\n",
      "docs/adr/0001-event-store.md": "# Keep an event store\n\nIt preserves the review history.\n",
      "src/ordering/docs/adr/0001-order-state.md": "# Model order state explicitly\n",
      "src/unlinked/CONTEXT.md": "# Unlinked context\n",
      "src/unlinked/docs/adr/0001-decoy.md": "# Unlinked decision\n",
    },
    expectedCandidates: [
      {
        name: "Commerce contexts",
        artifacts: [
          { path: "CONTEXT-MAP.md", role: "context-map" },
          { path: "src/ordering/CONTEXT.md", role: "context" },
          { path: "docs/adr/0001-event-store.md", role: "adr" },
          { path: "src/ordering/docs/adr/0001-order-state.md", role: "adr" },
        ],
      },
    ],
  },
];

describe("discoverDesignArtifacts", () => {
  it.each(familyCases)("discovers the $label artifact family", async (fixture) => {
    const repo = repository({ "src/change.ts": "export const change = true;\n", ...fixture.files });
    const result = await discoverDesignArtifacts({
      patchset: patchsetOf({
        ...repo,
        paths: ["src/change.ts"],
        surface: "github-pr",
      }),
      git: execaGit,
    });

    const candidates = result?.candidates.filter(
      (candidate) => candidate.format === fixture.format,
    );
    expect(
      candidates?.map((candidate) => ({
        name: candidate.name,
        artifacts: candidate.artifacts.map(({ path, role }) => ({ path, role })),
      })),
    ).toEqual(fixture.expectedCandidates);
  });

  it("discovers a standalone Superpowers design in a custom directory by topic shape", async () => {
    const path = "engineering/designs/2026-08-29-auth-design.md";
    const repo = repository({
      "src/change.ts": "export const change = true;\n",
      [path]: [
        "# Authentication design",
        "",
        "## System architecture",
        "",
        "## Component boundaries",
        "",
        "## Verification strategy",
      ].join("\n"),
    });

    const result = await discoverDesignArtifacts({
      patchset: patchsetOf({ ...repo, paths: ["src/change.ts"], surface: "github-pr" }),
      git: execaGit,
    });

    expect(result?.candidates).toHaveLength(1);
    expect(result?.candidates[0]).toMatchObject({
      format: "superpowers",
      name: "Authentication design",
      relevance: { kind: "repository-candidate" },
      artifacts: [{ path, role: "design" }],
    });
  });

  it("ranks an untouched relevant OpenSpec change ahead of an earlier decoy without discarding either", async () => {
    const repo = repository({
      "src/target.ts": "export const target = 1;\n",
      "openspec/changes/aaa-decoy/proposal.md": "# Decoy\n\nThis mentions only `src/target.tsx`.\n",
      "openspec/changes/zzz-target/proposal.md":
        "# Target\n\nThis change modifies `./src/target.ts`.\n",
    });
    writeFiles(repo.root, { "src/target.ts": "export const target = 2;\n" });

    const result = await discoverDesignArtifacts({
      patchset: patchsetOf({
        ...repo,
        paths: ["src/target.ts"],
        surface: "working-tree",
      }),
      git: execaGit,
    });
    const openspec = result?.candidates.filter((candidate) => candidate.format === "openspec");

    expect(openspec?.map((candidate) => candidate.name)).toEqual(["zzz-target", "aaa-decoy"]);
    expect(openspec?.[0]?.relevance).toEqual({
      kind: "references-changed-path",
      paths: ["src/target.ts"],
      omittedPathCount: 0,
    });
    expect(openspec?.[1]?.relevance).toEqual({ kind: "repository-candidate" });
  });

  it("reads disk for a working-tree review and the pinned head for a range review", async () => {
    const path = "openspec/changes/state/proposal.md";
    const repo = repository({ [path]: "# Proposal\n\nPinned head content.\n" });
    writeFiles(repo.root, { [path]: "# Proposal\n\nWorking tree content.\n" });

    const pinned = await discoverDesignArtifacts({
      patchset: patchsetOf({
        ...repo,
        paths: [path],
        surface: "working-tree",
        source: "github-local",
      }),
      git: execaGit,
    });
    const working = await discoverDesignArtifacts({
      patchset: patchsetOf({ ...repo, paths: [path], surface: "working-tree" }),
      git: execaGit,
    });

    expect(pinned?.candidates[0]?.artifacts[0]?.content).toContain("Pinned head content");
    expect(pinned?.candidates[0]?.artifacts[0]?.content).not.toContain("Working tree content");
    expect(working?.candidates[0]?.artifacts[0]?.content).toContain("Working tree content");

    const withSource = patchsetOf({ ...repo, paths: [path], surface: "github-pr" });
    const { source: _source, ...legacyLocal } = withSource;
    const legacy = await discoverDesignArtifacts({ patchset: legacyLocal, git: execaGit });
    expect(legacy?.candidates[0]?.artifacts[0]?.content).toContain("Working tree content");
  });

  it("uses BMAD configured paths instead of conventional decoys", async () => {
    const repo = repository({
      ".bmad-core/core-config.yaml": [
        "prd:",
        "  prdFile: product/specification.md",
        "  prdSharded: false",
        "  prdShardedLocation: product/stale-shards",
        "architecture:",
        "  architectureFile: engineering/system.md",
        "  architectureSharded: false",
        "  architectureShardedLocation: engineering/stale-shards",
        "devStoryLocation: delivery/work",
      ].join("\n"),
      "product/specification.md": "# Configured product\n",
      "engineering/system.md": "# Configured architecture\n",
      "delivery/work/2.1.story.md": "# Configured story\n",
      "product/stale-shards/epic-1-decoy.md": "# STALE CONFIGURED EPIC\n",
      "engineering/stale-shards/old.md": "# STALE CONFIGURED ARCHITECTURE\n",
      "docs/prd.md": "# CONVENTIONAL DECOY PRD\n",
      "docs/architecture.md": "# CONVENTIONAL DECOY ARCHITECTURE\n",
      "docs/stories/1.1.story.md": "# CONVENTIONAL DECOY STORY\n",
    });

    const result = await discoverDesignArtifacts({
      patchset: patchsetOf({ ...repo, paths: ["src/change.ts"], surface: "github-pr" }),
      git: execaGit,
    });
    const bmad = result?.candidates.find((candidate) => candidate.format === "bmad");

    expect(bmad?.artifacts.map((entry) => entry.path)).toEqual([
      "product/specification.md",
      "engineering/system.md",
      "delivery/work/2.1.story.md",
    ]);
    expect(bmad?.artifacts.map((entry) => entry.content).join("\n")).not.toContain("DECOY");
  });

  it("returns null when the repository contains no non-empty design artifacts", async () => {
    const repo = repository({
      "README.md": "# Plain repository\n",
      "openspec/changes/empty/proposal.md": "",
    });
    const result = await discoverDesignArtifacts({
      patchset: patchsetOf({ ...repo, paths: ["README.md"], surface: "github-pr" }),
      git: execaGit,
    });
    expect(result).toBeNull();
  });

  it("bounds a large unrelated corpus, retains the relevant target, and reports omissions", async () => {
    const files: Record<string, string> = { "src/target.ts": "export const target = 1;\n" };
    for (let index = 0; index < 60; index += 1) {
      const name = `candidate-${index.toString().padStart(3, "0")}`;
      files[`openspec/changes/${name}/proposal.md`] = `# ${name}\n\n${"x".repeat(20_000)}\n`;
    }
    files["openspec/changes/zzz-target/proposal.md"] =
      `# Target\n\nChanges \`src/target.ts\`.\n\n${"y".repeat(20_000)}\n`;
    const repo = repository(files);
    const result = await discoverDesignArtifacts({
      patchset: patchsetOf({ ...repo, paths: ["src/target.ts"], surface: "github-pr" }),
      git: execaGit,
    });

    expect(result?.candidates).toHaveLength(DESIGN_ARTIFACT_LIMITS.maxCandidates);
    expect(result?.candidates[0]?.name).toBe("zzz-target");
    expect(result?.omittedCandidateCount).toBe(13);
    expect(result?.candidates.some((candidate) => candidate.artifacts[0]?.truncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      DESIGN_ARTIFACT_LIMITS.maxSerializedBytes,
    );
  });
});
