import type { Patchset, PatchsetIntentSurface, PatchsetSource } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { readBmadSpec, resolveBmadPaths, selectedBmadSpec } from "./bmad-spec-reader";
import type { GitExec } from "./git-range-diff";

/** Build a Patchset over the given changed paths, root, head, and captured surface. */
function patchsetOf(opts: {
  root: string;
  headOid: string;
  reviewedTreeOid?: string;
  paths: string[];
  source?: PatchsetSource;
  surface?: PatchsetIntentSurface;
}): Patchset {
  return {
    id: "patchset-1",
    createdAt: "2026-09-04T00:00:00Z",
    repository: {
      id: "repo-1",
      root: opts.root,
      commonDir: `${opts.root}/.git`,
      baseRef: "main",
      baseOid: "base000",
      headOid: opts.headOid,
      ...(opts.reviewedTreeOid === undefined ? {} : { reviewedTreeOid: opts.reviewedTreeOid }),
    },
    files: opts.paths.map((path) => ({
      path,
      status: "added" as const,
      additions: 1,
      deletions: 0,
      binary: false,
      patch: "",
    })),
    rawDiff: "",
    byteLength: 0,
    truncated: false,
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.surface ? { intent: { surface: opts.surface } } : {}),
  };
}

/** A git runner backed by an in-memory tree keyed on `<oid>:<repo-relative-path>` (`git show`). */
function fakeGit(tree: Record<string, string>): GitExec {
  return (async (_root: string, args: string[]) => {
    if (args[0] === "show") {
      const ref = args[1] ?? "";
      const content = tree[ref];
      if (content === undefined) throw new Error(`fatal: ${ref} does not exist`);
      return content;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  }) as GitExec;
}

const STORY_MD = `# Story 1.2: Wire the reader

## Status

Approved

## Story

As a reviewer, I want the reader wired, so that touched stories render.

## Acceptance Criteria

1. The reader honors core-config.yaml overrides.

## Tasks / Subtasks

- [x] Task 1: Discover config (AC: 1)
  - [ ] Subtask 1.1: Resolve paths
`;

describe("resolveBmadPaths", () => {
  it("defaults to the conventional .bmad/** locations when there is no config", () => {
    const paths = resolveBmadPaths(undefined);
    expect(paths.prdFile).toBe(".bmad/prd.md");
    expect(paths.architectureFile).toBe(".bmad/architecture.md");
    expect(paths.storyLocation).toBe(".bmad/stories");
  });

  it("lets core-config.yaml relocate the PRD, architecture, and story paths (override wins)", () => {
    const config = `markdownExploder: true
prd:
  prdFile: docs/prd.md
  prdSharded: true
  prdShardedLocation: docs/prd
  epicFilePattern: epic-{n}*.md
architecture:
  architectureFile: docs/architecture.md
  architectureSharded: true
devStoryLocation: docs/stories
`;
    const paths = resolveBmadPaths(config);
    expect(paths.prdFile).toBe("docs/prd.md");
    expect(paths.architectureFile).toBe("docs/architecture.md");
    expect(paths.storyLocation).toBe("docs/stories");
    expect(paths.epicLocation).toBe("docs/prd");
    expect(paths.epicBasename("epic-1-foundation.md")).toBe(true);
    expect(paths.epicBasename("prd.md")).toBe(false);
  });
});

describe("selectedBmadSpec", () => {
  it("selects the touched story and names the spec by its N.M filename id", () => {
    const paths = resolveBmadPaths(undefined);
    const selected = selectedBmadSpec([".bmad/stories/1.2.story.md", "src/other.ts"], paths);
    expect(selected?.name).toBe("1.2");
    expect(selected?.storyPaths).toEqual([".bmad/stories/1.2.story.md"]);
  });

  it("returns null when no changed path is a BMAD document", () => {
    expect(selectedBmadSpec(["src/a.ts", "README.md"], resolveBmadPaths(undefined))).toBeNull();
  });
});

describe("readBmadSpec — honors core-config.yaml overrides and reads at the reviewed tree", () => {
  it("reads the relocated PRD + the touched story from reviewedTreeOid, never later disk bytes", async () => {
    const root = "/tmp/bmad-repo";
    const oid = "reviewed-tree";
    const config = `prd:
  prdFile: docs/prd.md
architecture:
  architectureFile: docs/architecture.md
devStoryLocation: docs/stories
`;
    const git = vi.fn(
      fakeGit({
        [`${oid}:.bmad-core/core-config.yaml`]: config,
        [`${oid}:docs/prd.md`]: "## Requirements\n\n- FR1: The system SHALL work.\n",
        // The conventional .bmad/prd.md is deliberately absent — the override path wins.
        [`${oid}:docs/stories/1.2.story.md`]: STORY_MD,
      }),
    );
    const spec = await readBmadSpec(
      patchsetOf({
        root,
        headOid: "head000",
        reviewedTreeOid: oid,
        surface: "working-tree",
        paths: ["docs/stories/1.2.story.md", "src/unrelated.ts"],
      }),
      git,
    );
    expect(spec?.name).toBe("1.2");
    expect(spec?.prd?.requirements.map((r) => r.id)).toEqual(["FR1"]);
    expect(spec?.stories.map((s) => s.path)).toEqual(["docs/stories/1.2.story.md"]);
    expect(spec?.stories[0]?.story?.status).toBe("Approved");
    expect(git).toHaveBeenCalled();
  });

  it("falls back to the conventional .bmad/** layout when there is no core-config.yaml", async () => {
    const root = "/tmp/bmad-repo";
    const oid = "head000";
    const git = fakeGit({
      // no core-config.yaml at the tree → git show throws → conventional defaults
      [`${oid}:.bmad/prd.md`]: "## Requirements\n\n- NFR1: SHALL be fast.\n",
      [`${oid}:.bmad/stories/2.1.story.md`]: STORY_MD,
    });
    const spec = await readBmadSpec(
      patchsetOf({
        root,
        headOid: oid,
        source: "github-local",
        surface: "github-pr",
        paths: [".bmad/stories/2.1.story.md"],
      }),
      git,
    );
    expect(spec?.name).toBe("2.1");
    expect(spec?.prd?.requirements[0]?.id).toBe("NFR1");
    expect(spec?.architecture).toBeUndefined();
    expect(spec?.stories[0]?.story?.acceptanceCriteria[0]?.text).toContain("core-config.yaml");
  });

  it("returns null when the reviewed patchset touches no BMAD document", async () => {
    const spec = await readBmadSpec(
      patchsetOf({
        root: "/tmp/bmad-repo",
        headOid: "head000",
        surface: "working-tree",
        paths: ["src/only.ts"],
      }),
      fakeGit({}),
    );
    expect(spec).toBeNull();
  });
});
