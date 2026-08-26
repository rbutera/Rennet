import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Patchset, PatchsetIntentSurface, PatchsetSource } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitExec } from "./git-range-diff";
import { readOpenSpecChange, selectedOpenSpecChangeName } from "./openspec-change-reader";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const root of tmpRoots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rennet-openspec-"));
  tmpRoots.push(root);
  return root;
}

/** Build a Patchset over the given changed paths, root, head, and captured surface. */
function patchsetOf(opts: {
  root: string;
  headOid: string;
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

/** A git runner backed by an in-memory tree at `headOid` (`git show` + `git ls-tree`). */
function fakeGit(
  _headOid: string,
  tree: Record<string, string>,
  specs: Record<string, string[]>,
): GitExec {
  return (async (_root: string, args: string[]) => {
    if (args[0] === "show") {
      const ref = args[1] ?? "";
      const content = tree[ref];
      if (content === undefined) throw new Error(`fatal: ${ref} does not exist`);
      return content;
    }
    if (args[0] === "ls-tree") {
      const ref = args[args.length - 1] ?? "";
      return (specs[ref] ?? []).join("\n");
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  }) as GitExec;
}

describe("selectedOpenSpecChangeName", () => {
  it("picks the change the changed paths touch, deterministically (first by sort)", () => {
    expect(
      selectedOpenSpecChangeName(["openspec/changes/my-change/proposal.md", "src/other.ts"]),
    ).toBe("my-change");
    expect(
      selectedOpenSpecChangeName([
        "openspec/changes/beta/tasks.md",
        "openspec/changes/alpha/proposal.md",
      ]),
    ).toBe("alpha");
  });

  it("returns null when no changed path is under openspec/changes/", () => {
    expect(selectedOpenSpecChangeName(["src/a.ts", "README.md"])).toBeNull();
  });
});

describe("readOpenSpecChange — working-tree review (reads the checked-out disk)", () => {
  function seedDisk(root: string, name: string, proposal: string): void {
    const dir = join(root, "openspec", "changes", name);
    mkdirSync(join(dir, "specs", "cap-a"), { recursive: true });
    writeFileSync(join(dir, "proposal.md"), proposal);
    writeFileSync(
      join(dir, "tasks.md"),
      "# Tasks\n\n## 1. Group\n\n- [x] 1.1 done\n- [ ] 1.2 todo\n",
    );
    writeFileSync(
      join(dir, "specs", "cap-a", "spec.md"),
      "## ADDED Requirements\n\n### Requirement: It works\n\nIt SHALL work.\n\n#### Scenario: happy\n\n- **WHEN** x\n- **THEN** y\n",
    );
  }

  it("reads and parses the selected change from disk, never touching git", async () => {
    const root = tempRoot();
    seedDisk(root, "my-change", "## Why\n\nWorking-tree proposal.\n");
    const gitMustNotRun = vi.fn(() =>
      Promise.reject(new Error("git must not run for a working-tree review")),
    );
    const change = await readOpenSpecChange(
      patchsetOf({
        root,
        headOid: "head000",
        surface: "working-tree",
        paths: ["openspec/changes/my-change/proposal.md", "src/unrelated.ts"],
      }),
      gitMustNotRun as unknown as GitExec,
    );
    expect(change?.name).toBe("my-change");
    expect(JSON.stringify(change?.proposal)).toContain("Working-tree proposal");
    expect(change?.tasks?.total).toBe(2);
    expect(change?.specDeltas.map((delta) => delta.capability)).toEqual(["cap-a"]);
    expect(gitMustNotRun).not.toHaveBeenCalled();
  });

  it("returns null when the reviewed patchset touches no openspec change", async () => {
    const root = tempRoot();
    seedDisk(root, "my-change", "## Why\n\nx\n");
    const change = await readOpenSpecChange(
      patchsetOf({ root, headOid: "head000", surface: "working-tree", paths: ["src/only.ts"] }),
      fakeGit("head000", {}, {}),
    );
    expect(change).toBeNull();
  });
});

describe("readOpenSpecChange — PR review (reads git show at the head OID, not the checkout)", () => {
  it("renders the PR head's change even when the checkout is on base without it (regression)", async () => {
    const root = tempRoot();
    // The base checkout on disk has a STALE proposal for this change — a PR review must
    // NOT read it. (It could equally be absent, for a PR that adds the change.)
    const dir = join(root, "openspec", "changes", "pr-change");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "proposal.md"),
      "## Why\n\nBASE checkout content — must not surface.\n",
    );

    const headOid = "abc123";
    const proposalPath = `${headOid}:openspec/changes/pr-change/proposal.md`;
    const specPath = `${headOid}:openspec/changes/pr-change/specs/cap-x/spec.md`;
    const git = fakeGit(
      headOid,
      {
        [proposalPath]: "## Why\n\nPR HEAD proposal — the reviewed content.\n",
        [specPath]:
          "## ADDED Requirements\n\n### Requirement: Head requirement\n\nSHALL hold at head.\n\n#### Scenario: s\n\n- **WHEN** a\n- **THEN** b\n",
      },
      { [`${headOid}:openspec/changes/pr-change/specs`]: ["cap-x"] },
    );

    const change = await readOpenSpecChange(
      patchsetOf({
        root,
        headOid,
        source: "github-local",
        surface: "github-pr",
        paths: [
          "openspec/changes/pr-change/proposal.md",
          "openspec/changes/pr-change/specs/cap-x/spec.md",
        ],
      }),
      git,
    );

    expect(change?.name).toBe("pr-change");
    // The reviewed HEAD content is rendered; the base checkout content is not.
    expect(JSON.stringify(change?.proposal)).toContain("PR HEAD proposal");
    expect(JSON.stringify(change?.proposal)).not.toContain("BASE checkout content");
    // Artifacts absent at head (git show throws) are honestly omitted.
    expect(change?.design).toBeUndefined();
    expect(change?.tasks).toBeUndefined();
    // The spec delta is read at head too.
    const requirement = change?.specDeltas[0]?.groups[0]?.requirements[0];
    expect(change?.specDeltas.map((delta) => delta.capability)).toEqual(["cap-x"]);
    expect(requirement?.name).toBe("Head requirement");
    expect(requirement?.source?.artifact).toBe("spec");
  });
});
