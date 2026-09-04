import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Patchset, PatchsetIntentSurface, PatchsetSource } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitExec } from "./git-range-diff";
import { readKiroSpec, selectedKiroFeatureName } from "./kiro-spec-reader";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-kiro-"));
  tmpRoots.push(root);
  return root;
}

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
    createdAt: "2026-08-11T00:00:00Z",
    repository: {
      id: "repo-1",
      root: opts.root,
      commonDir: join(opts.root, ".git"),
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

/** A git runner backed by an in-memory tree at `headOid` (`git show <oid>:<path>`). */
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

describe("selectedKiroFeatureName", () => {
  it("picks the feature the changed paths touch, deterministically (first by sort)", () => {
    expect(selectedKiroFeatureName([".kiro/specs/session/requirements.md", "src/other.ts"])).toBe(
      "session",
    );
    expect(
      selectedKiroFeatureName([".kiro/specs/session/tasks.md", ".kiro/specs/account/design.md"]),
    ).toBe("account");
  });

  it("returns null when no changed path is under .kiro/specs/", () => {
    expect(selectedKiroFeatureName(["src/a.ts", "openspec/changes/x/proposal.md"])).toBeNull();
  });
});

const REQUIREMENTS_MD = [
  "### Requirement 1",
  "",
  "**User Story:** As a reviewer, I want sessions to survive restarts.",
  "",
  "#### Acceptance Criteria",
  "",
  "1. WHEN the application restarts THEN the system SHALL restore the session",
].join("\n");

const TASKS_MD = [
  "# Implementation Plan",
  "",
  "- [x] 1. Build the store",
  "  - _Requirements: 1.1_",
  "- [ ] 1.1 Add persistence",
].join("\n");

describe("readKiroSpec — working-tree review (reads the captured tree)", () => {
  it("reads and parses the selected feature from reviewedTreeOid, never later disk bytes", async () => {
    const root = tempRoot();
    // Later disk bytes that must NOT surface (the review reads the captured tree).
    const dir = join(root, ".kiro", "specs", "session");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "requirements.md"),
      "### Requirement 9\n\n**User Story:** disk only.\n",
    );

    const reviewedTreeOid = "reviewed-tree";
    const reqPath = `${reviewedTreeOid}:.kiro/specs/session/requirements.md`;
    const tasksPath = `${reviewedTreeOid}:.kiro/specs/session/tasks.md`;
    const git = vi.fn(fakeGit({ [reqPath]: REQUIREMENTS_MD, [tasksPath]: TASKS_MD }));

    const spec = await readKiroSpec(
      patchsetOf({
        root,
        headOid: "head000",
        reviewedTreeOid,
        surface: "working-tree",
        paths: [".kiro/specs/session/requirements.md", "src/unrelated.ts"],
      }),
      git,
    );

    expect(spec?.feature).toBe("session");
    expect(spec?.requirements?.requirements[0]?.label).toBe("Requirement 1");
    expect(JSON.stringify(spec?.requirements)).not.toContain("disk only");
    expect(spec?.tasks?.total).toBe(2);
    expect(spec?.tasks?.groups[0]?.items[0]?.requirementRefs).toEqual(["1.1"]);
    // design.md and bugfix.md are absent at the reviewed tree, honestly omitted.
    expect(spec?.design).toBeUndefined();
    expect(spec?.bugfix).toBeUndefined();
    expect(git).toHaveBeenCalled();
  });

  it("returns null when the reviewed patchset touches no Kiro feature", async () => {
    const root = tempRoot();
    const spec = await readKiroSpec(
      patchsetOf({ root, headOid: "head000", surface: "working-tree", paths: ["src/only.ts"] }),
      fakeGit({}),
    );
    expect(spec).toBeNull();
  });

  it("returns null for a deletion-only patchset — feature named, no artifact survives", async () => {
    const root = tempRoot();
    // The changed paths name `session` (its files were removed), but every artifact read
    // at the reviewed tree is absent. That is "no Kiro spec here", not an empty spec.
    const spec = await readKiroSpec(
      patchsetOf({
        root,
        headOid: "head000",
        reviewedTreeOid: "reviewed-tree",
        surface: "working-tree",
        paths: [".kiro/specs/session/requirements.md", ".kiro/specs/session/tasks.md"],
      }),
      fakeGit({}), // every `git show` throws → every read undefined
    );
    expect(spec).toBeNull();
  });
});

describe("readKiroSpec — PR review (reads git show at the head OID, not the checkout)", () => {
  it("renders the PR head's feature even when the checkout lacks it", async () => {
    const root = tempRoot();
    const headOid = "abc123";
    const reqPath = `${headOid}:.kiro/specs/pr-feature/requirements.md`;
    const git = fakeGit({ [reqPath]: REQUIREMENTS_MD });

    const spec = await readKiroSpec(
      patchsetOf({
        root,
        headOid,
        source: "github-local",
        surface: "github-pr",
        paths: [".kiro/specs/pr-feature/requirements.md"],
      }),
      git,
    );

    expect(spec?.feature).toBe("pr-feature");
    expect(spec?.requirements?.requirements[0]?.id).toBe("1");
    expect(spec?.tasks).toBeUndefined();
    expect(spec?.design).toBeUndefined();
  });
});
