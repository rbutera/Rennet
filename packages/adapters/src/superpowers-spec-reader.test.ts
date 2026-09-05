import { join } from "node:path";
import type { Patchset, PatchsetIntentSurface, PatchsetSource } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import type { GitExec } from "./git-range-diff";
import { readSuperpowersSpec, selectedSuperpowersArtifacts } from "./superpowers-spec-reader";

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
    createdAt: "2026-08-29T00:00:00Z",
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

const PLAN_REL = "docs/superpowers/plans/2026-08-29-session.md";
const SPEC_REL = "docs/superpowers/specs/session.md";
const PROGRESS_REL = ".superpowers/sdd/session/progress.md";

const PLAN_MD = [
  "**Spec:** docs/superpowers/specs/session.md",
  "",
  "### Task 1: Persist sessions",
  "- [x] Step 1 Write the failing test",
  "- [ ] Step 2 Implement persistence",
].join("\n");

const SPEC_MD = "# Design\n\n## Context\n\nKeep the store as the source of truth.";
const PROGRESS_MD = [
  `# SDD ledger — plan: ${PLAN_REL}`,
  "Task 1: complete (commits abc..def, review clean)",
].join("\n");

describe("selectedSuperpowersArtifacts", () => {
  it("classifies plan/spec/progress paths and ignores unrelated files", () => {
    expect(
      selectedSuperpowersArtifacts([
        PLAN_REL,
        SPEC_REL,
        PROGRESS_REL,
        "src/other.ts",
        "docs/superpowers/README.md",
      ]),
    ).toEqual({ plans: [PLAN_REL], specs: [SPEC_REL], progress: [PROGRESS_REL] });
  });

  it("sorts within a kind and returns empty lists when nothing matches", () => {
    expect(selectedSuperpowersArtifacts(["src/a.ts", "README.md"])).toEqual({
      plans: [],
      specs: [],
      progress: [],
    });
  });
});

describe("readSuperpowersSpec", () => {
  it("reads plan + progress from reviewedTreeOid and resolves the plan's Spec pointer", async () => {
    const root = "/repo";
    const reviewedTreeOid = "reviewed-tree";
    const git = vi.fn(
      fakeGit({
        [`${reviewedTreeOid}:${PLAN_REL}`]: PLAN_MD,
        [`${reviewedTreeOid}:${SPEC_REL}`]: SPEC_MD,
        [`${reviewedTreeOid}:${PROGRESS_REL}`]: PROGRESS_MD,
      }),
    );
    // The diff touches the plan and progress, NOT the spec — the spec is resolved via
    // the plan's `**Spec:**` pointer.
    const spec = await readSuperpowersSpec(
      patchsetOf({
        root,
        headOid: "head000",
        reviewedTreeOid,
        surface: "working-tree",
        paths: [PLAN_REL, PROGRESS_REL, "src/unrelated.ts"],
      }),
      git,
    );
    expect(spec?.name).toBe("session");
    expect(spec?.plans[0]?.path).toBe(PLAN_REL);
    expect(spec?.plans[0]?.taskGroups[0]?.steps).toHaveLength(2);
    // The spec pointer was resolved and parsed even though it was not in the diff.
    expect(spec?.specs.map((designSpec) => designSpec.path)).toEqual([SPEC_REL]);
    expect(spec?.specs[0]?.sections[0]?.heading).toBe("Context");
    // The progress ledger binds to the plan.
    expect(spec?.progressLedgers[0]?.planPath).toBe(PLAN_REL);
    expect(spec?.progressLedgers[0]?.entries[0]?.kind).toBe("task-complete");
    expect(git).toHaveBeenCalled();
  });

  it("returns null when the reviewed patchset touches no Superpowers artifact", async () => {
    const spec = await readSuperpowersSpec(
      patchsetOf({
        root: "/repo",
        headOid: "head000",
        surface: "working-tree",
        paths: ["src/only.ts"],
      }),
      fakeGit({}),
    );
    expect(spec).toBeNull();
  });

  it("returns null when the patchset only deletes its Superpowers artifacts", async () => {
    // The diff touches the plan and progress by path (they are classified), but both are
    // GONE at the reviewed tree — a deletion-only review. `git show` fails on each, so every
    // read is absent. The result must be null, not an empty-but-non-null spec.
    const spec = await readSuperpowersSpec(
      patchsetOf({
        root: "/repo",
        headOid: "head000",
        surface: "working-tree",
        paths: [PLAN_REL, PROGRESS_REL],
      }),
      fakeGit({}),
    );
    expect(spec).toBeNull();
  });

  it("names a progress-ledger-only review from its session directory, not the file basename", async () => {
    // Only the ledger is in the diff; its path is `.superpowers/sdd/session/progress.md`.
    // The feature is the session dir "session" — NOT the basename "progress".
    const spec = await readSuperpowersSpec(
      patchsetOf({
        root: "/repo",
        headOid: "head000",
        surface: "working-tree",
        paths: [PROGRESS_REL],
      }),
      fakeGit({ [`head000:${PROGRESS_REL}`]: PROGRESS_MD }),
    );
    expect(spec?.name).toBe("session");
    expect(spec?.progressLedgers[0]?.planPath).toBe(PLAN_REL);
  });

  it("reads at the head OID for a PR review, not the checkout, and omits absent artifacts", async () => {
    const root = "/repo";
    const headOid = "abc123";
    // Only the plan exists at head; the spec pointer resolves to a file absent at head,
    // which `git show` fails on — honestly omitted, never thrown.
    const git = fakeGit({ [`${headOid}:${PLAN_REL}`]: PLAN_MD });
    const spec = await readSuperpowersSpec(
      patchsetOf({
        root,
        headOid,
        source: "github-local",
        surface: "github-pr",
        paths: [PLAN_REL],
      }),
      git,
    );
    expect(spec?.plans[0]?.path).toBe(PLAN_REL);
    expect(spec?.specs).toEqual([]);
    expect(spec?.progressLedgers).toEqual([]);
  });
});
