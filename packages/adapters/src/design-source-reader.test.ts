import type { Patchset } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import { readDesignSources } from "./design-source-reader";
import type { GitExec } from "./git-range-diff";

const HEAD = "head000";

/** Build a Patchset over the given changed paths at `HEAD`. */
function patchsetOf(paths: readonly string[]): Patchset {
  return {
    id: "patchset-1",
    createdAt: "2026-08-11T00:00:00Z",
    repository: {
      id: "repo-1",
      root: "/repo",
      commonDir: "/repo/.git",
      baseRef: "main",
      baseOid: "base000",
      headOid: HEAD,
    },
    files: paths.map((path) => ({
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
  };
}

/**
 * A git runner backed by an in-memory tree at `HEAD` (`git show <oid>:<path>` and the
 * `git ls-tree` the OpenSpec reader uses to list a change's capabilities), that also
 * counts every call — the "one `git show` at most" claim is a number, not a feeling.
 */
function fakeGit(tree: Record<string, string>): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const git = (async (_root: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "show") {
      const content = tree[(args[1] ?? "").replace(`${HEAD}:`, "")];
      if (content === undefined) throw new Error(`fatal: ${args[1]} does not exist`);
      return content;
    }
    if (args[0] === "ls-tree") {
      const dir = (args[args.length - 1] ?? "").replace(`${HEAD}:`, "");
      const names = new Set<string>();
      for (const path of Object.keys(tree)) {
        if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split("/")[0] ?? "");
      }
      return [...names].join("\n");
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  }) as GitExec;
  return { git, calls };
}

const KIRO_TASKS = ".kiro/specs/session/tasks.md";
const OPENSPEC_PROPOSAL = "openspec/changes/session/proposal.md";
const ADR = "docs/adr/0001-keep-an-event-store.md";

describe("readDesignSources", () => {
  it("returns null, after at most one git call, when the patchset touches no specification", async () => {
    const { git, calls } = fakeGit({});
    await expect(readDesignSources(patchsetOf(["src/a.ts", "README.md"]), git)).resolves.toBeNull();
    // BMAD's `core-config.yaml` is the one read a path check cannot replace.
    expect(calls).toEqual([["show", `${HEAD}:.bmad-core/core-config.yaml`]]);
  });

  it("reads a Kiro feature as design sources in its reading order, with the Kiro roles", async () => {
    const { git } = fakeGit({
      ".kiro/specs/session/requirements.md": "# Requirements",
      [KIRO_TASKS]: "- [ ] 1. Build the store",
    });
    const sources = await readDesignSources(patchsetOf([KIRO_TASKS, "src/a.ts"]), git);
    expect(sources?.map((source) => [source.format, source.role, source.path])).toEqual([
      ["kiro", "requirements", ".kiro/specs/session/requirements.md"],
      ["kiro", "tasks", KIRO_TASKS],
    ]);
    expect(sources?.every((source) => source.candidate === "session")).toBe(true);
    expect(sources?.[1]?.text).toBe("- [ ] 1. Build the store");
  });

  it("reads a grill ADR when nothing more structured is touched", async () => {
    const { git } = fakeGit({ [ADR]: "# Keep an event store\n\nIt preserves history.\n" });
    const sources = await readDesignSources(patchsetOf([ADR]), git);
    expect(sources?.map((source) => [source.format, source.role, source.candidate])).toEqual([
      ["grill-with-docs", "adr", "0001-keep-an-event-store"],
    ]);
  });

  // One specification, never a merge: an ADR beside an OpenSpec change is context for
  // it, and a Kiro feature beside one is the older workflow. The order is fixed so the
  // same patchset always assembles the same board.
  it("prefers OpenSpec over Kiro over grill when a patchset touches more than one", async () => {
    const { git } = fakeGit({
      [OPENSPEC_PROPOSAL]: "## Why\nBecause.",
      [KIRO_TASKS]: "- [ ] 1. Build the store",
      [ADR]: "# Keep an event store\n\nIt preserves history.\n",
    });
    const all = await readDesignSources(patchsetOf([ADR, KIRO_TASKS, OPENSPEC_PROPOSAL]), git);
    expect(all?.map((source) => source.format)).toEqual(["openspec"]);

    const noOpenSpec = await readDesignSources(patchsetOf([ADR, KIRO_TASKS]), git);
    expect(noOpenSpec?.map((source) => source.format)).toEqual(["kiro"]);
  });

  it("falls through a format whose files are all gone at the reviewed tree", async () => {
    // The Kiro path is touched (a deletion) but nothing survives at HEAD; the ADR does.
    const { git } = fakeGit({ [ADR]: "# Keep an event store\n\nIt preserves history.\n" });
    const sources = await readDesignSources(patchsetOf([KIRO_TASKS, ADR]), git);
    expect(sources?.map((source) => source.format)).toEqual(["grill-with-docs"]);
  });
});
