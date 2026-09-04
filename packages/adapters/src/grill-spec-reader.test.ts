import type { Patchset, PatchsetIntentSurface, PatchsetSource } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import type { GitExec } from "./git-range-diff";
import { readGrillSpec, selectedGrillDocPaths } from "./grill-spec-reader";

/** Narrow an optional to present, or fail the test loudly. */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a present value");
  return value;
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

/** A git runner backed by an in-memory tree at a single OID (`git show <oid>:<path>`). */
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

const ADR_MD = `# Store the reviewed tree as an immutable Git object

Working-tree bytes drift; a captured tree does not.

## Considered Options

- Pin a full Git tree object
- Re-read the working tree on open
`;

const CONTEXT_MD = `# Glossary

## Language

### Review objects

- **Patchset**: the immutable capture of a change under review.
  _Avoid_: diff, changeset
`;

const CONTEXT_MAP_MD = `# System context map

## Contexts

- [Ordering](src/ordering/CONTEXT.md) - Receives and tracks orders
- [Billing](src/billing/CONTEXT.md)

## Relationships

- Ordering → Billing
`;

describe("selectedGrillDocPaths", () => {
  it("splits changed paths into ADRs, CONTEXT docs, and CONTEXT-MAP docs, deterministically sorted", () => {
    const selected = selectedGrillDocPaths([
      "docs/adr/0007-tree.md",
      "docs/adr/0002-base-ui.md",
      "docs/decisions/routing.md",
      "src/ordering/docs/adr/0001-event-sourced.md",
      "packages/core/CONTEXT.md",
      "CONTEXT-MAP.md",
      "src/other.ts",
      "docs/adr/README.md",
    ]);
    // Context-local ADRs (any-depth `docs/adr/`) are recognised alongside the root's.
    expect(selected.adrs).toEqual([
      "docs/adr/0002-base-ui.md",
      "docs/adr/0007-tree.md",
      "docs/adr/README.md",
      "docs/decisions/routing.md",
      "src/ordering/docs/adr/0001-event-sourced.md",
    ]);
    expect(selected.contextDocs).toEqual(["packages/core/CONTEXT.md"]);
    expect(selected.contextMaps).toEqual(["CONTEXT-MAP.md"]);
  });

  it("does not match a docs/adr segment that is not on a path boundary", () => {
    // `mydocs/adr/` shares the letters but not the boundary — it is not an ADR dir.
    expect(selectedGrillDocPaths(["mydocs/adr/note.md"]).adrs).toEqual([]);
  });

  it("ignores paths that are neither ADRs nor CONTEXT/CONTEXT-MAP docs", () => {
    expect(selectedGrillDocPaths(["src/a.ts", "README.md", "docs/guide.md"])).toEqual({
      adrs: [],
      contextDocs: [],
      contextMaps: [],
    });
  });
});

describe("readGrillSpec", () => {
  it("reads and parses touched grill docs from reviewedTreeOid, never later disk bytes", async () => {
    const root = "/tmp/repo";
    const reviewedTreeOid = "reviewed-tree";
    const git = vi.fn(
      fakeGit({
        [`${reviewedTreeOid}:docs/adr/0007-tree.md`]: ADR_MD,
        [`${reviewedTreeOid}:CONTEXT.md`]: CONTEXT_MD,
      }),
    );
    const spec = present(
      await readGrillSpec(
        patchsetOf({
          root,
          headOid: "head000",
          reviewedTreeOid,
          surface: "working-tree",
          paths: ["docs/adr/0007-tree.md", "CONTEXT.md", "src/unrelated.ts"],
        }),
        git,
      ),
    );
    expect(spec.decisions.map((decision) => decision.title)).toEqual([
      "Store the reviewed tree as an immutable Git object",
    ]);
    expect(present(spec.decisions[0]).alternatives).toEqual([
      "Pin a full Git tree object",
      "Re-read the working tree on open",
    ]);
    expect(spec.glossary.map((entry) => entry.term)).toEqual(["Patchset"]);
    expect(present(spec.glossary[0]).avoid).toEqual(["diff", "changeset"]);
    // Raw source rides along verbatim for the viewer's raw-flip (#239).
    expect(spec.raw.adrs).toEqual([{ path: "docs/adr/0007-tree.md", md: ADR_MD }]);
    expect(spec.raw.contextDocs).toEqual([{ path: "CONTEXT.md", md: CONTEXT_MD }]);
    expect(git).toHaveBeenCalled();
  });

  it("reads a context-local ADR and a root CONTEXT-MAP.md in a multi-context repo", async () => {
    const reviewedTreeOid = "reviewed-tree";
    const localAdr = "src/ordering/docs/adr/0001-event-sourced.md";
    const git = fakeGit({
      [`${reviewedTreeOid}:${localAdr}`]: ADR_MD,
      [`${reviewedTreeOid}:CONTEXT-MAP.md`]: CONTEXT_MAP_MD,
    });
    const spec = present(
      await readGrillSpec(
        patchsetOf({
          root: "/tmp/repo",
          headOid: "head000",
          reviewedTreeOid,
          surface: "working-tree",
          paths: [localAdr, "CONTEXT-MAP.md"],
        }),
        git,
      ),
    );
    expect(spec.decisions.map((decision) => decision.title)).toEqual([
      "Store the reviewed tree as an immutable Git object",
    ]);
    expect(present(spec.decisions[0]).source.path).toBe(localAdr);
    expect(spec.contextMaps).toHaveLength(1);
    const map = present(spec.contextMaps[0]);
    expect(map.contexts.map((context) => context.name)).toEqual(["Ordering", "Billing"]);
    expect(map.relationships).toEqual([
      {
        from: "Ordering",
        to: "Billing",
        direction: "->",
        source: { path: "CONTEXT-MAP.md", line: 10 },
      },
    ]);
    expect(spec.raw.contextMaps).toEqual([{ path: "CONTEXT-MAP.md", md: CONTEXT_MAP_MD }]);
  });

  it("reads at headOid for a PR review, and omits a doc absent at that OID", async () => {
    const headOid = "abc123";
    const git = fakeGit({
      [`${headOid}:docs/adr/0007-tree.md`]: ADR_MD,
      // CONTEXT.md is absent at head — git show throws, and it is honestly omitted.
    });
    const spec = present(
      await readGrillSpec(
        patchsetOf({
          root: "/tmp/repo",
          headOid,
          source: "github-local",
          surface: "github-pr",
          paths: ["docs/adr/0007-tree.md", "CONTEXT.md"],
        }),
        git,
      ),
    );
    expect(spec.decisions).toHaveLength(1);
    expect(spec.glossary).toEqual([]);
    expect(spec.contextMaps).toEqual([]);
  });

  it("returns null when the reviewed patchset touches no grill document", async () => {
    const spec = await readGrillSpec(
      patchsetOf({
        root: "/tmp/repo",
        headOid: "head000",
        surface: "working-tree",
        paths: ["src/only.ts", "README.md"],
      }),
      fakeGit({}),
    );
    expect(spec).toBeNull();
  });

  it("returns null when the only touched grill doc is absent at the reviewed OID", async () => {
    const spec = await readGrillSpec(
      patchsetOf({
        root: "/tmp/repo",
        headOid: "head000",
        surface: "working-tree",
        paths: ["docs/adr/gone.md"],
      }),
      fakeGit({}),
    );
    expect(spec).toBeNull();
  });
});
