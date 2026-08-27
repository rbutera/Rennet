import {
  commandDefinitions,
  projectProcessEventSchema,
  reviewAskStreamEventSchema,
} from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  buildProjectionContext,
  INBOUND_HOST_PATH_FIELDS,
  INBOUND_REPO_RELATIVE_PATH_FIELDS,
  ProjectionResolveError,
  projectCommandOutput,
  projectProgressEvent,
  redactAbsolutePaths,
  resolveCommandInput,
  scrubRoots,
  toRepoReference,
} from "./projection";

const HOME = "/home/rai";
const REPO = "/home/rai/dev/rennet";
const OTHER = "/home/rai/dev/web";
const ctx = buildProjectionContext([REPO, OTHER], HOME);

describe("projection context + reference codec", () => {
  it("projects a root path to a repoKey reference with no relative tail", () => {
    const ref = toRepoReference(REPO, ctx);
    expect(ref.displayName).toBe("rennet");
    expect(ref.relativePath).toBeUndefined();
    expect(ref.repoKey).not.toContain("/"); // escaped, off-machine-meaningless
    expect(ref.repoKey).not.toContain(REPO);
  });

  it("keeps the repo-relative tail for a path under a root", () => {
    const ref = toRepoReference(`${REPO}/packages/server/src/x.ts`, ctx);
    expect(ref.displayName).toBe("rennet");
    expect(ref.relativePath).toBe("packages/server/src/x.ts");
  });

  it("still references an UNKNOWN path without leaking it", () => {
    const ref = toRepoReference("/home/rai/secret/elsewhere", ctx);
    expect(ref.repoKey).not.toContain("/");
    expect(JSON.stringify(ref)).not.toContain("/home/rai/secret");
  });
});

describe("outbound structural projection", () => {
  const provenance = {
    id: "p",
    root: REPO,
    commonDir: `${REPO}/.git`,
    baseRef: "main",
    baseOid: "a",
    headOid: "b",
  };
  const review = {
    id: "r1",
    repositoryRoot: REPO,
    activePatchsetId: "ps1",
    dispositions: [{ path: "packages/server/src/x.ts" }],
    status: "current",
    patchsets: [
      { id: "ps1", createdAt: "2026-01-01T00:00:00.000Z", repository: provenance, files: [] },
    ],
  };

  it("projects every listed host-path field in a review response", () => {
    const out = projectCommandOutput("review.capture", { review }, ctx) as {
      review: Record<string, unknown>;
    };
    const projected = out.review;
    expect((projected.repositoryRoot as { repoKey: string }).repoKey).toBeTruthy();
    const ps = (projected.patchsets as Record<string, unknown>[])[0] as Record<string, unknown>;
    const prov = ps.repository as Record<string, { repoKey: string }>;
    expect(prov.root?.repoKey).toBeTruthy();
    expect(prov.commonDir?.repoKey).toBeTruthy();
    // A repo-relative disposition path is UNTOUCHED (not a host path).
    expect((projected.dispositions as { path: string }[])[0]?.path).toBe(
      "packages/server/src/x.ts",
    );
    // The whole serialized frame carries no host-absolute path.
    expect(JSON.stringify(out)).not.toContain(REPO);
    expect(JSON.stringify(out)).not.toContain(HOME);
    // Without an attention-capable context, the projected review omits the summary entirely.
    expect(projected.attention).toBeUndefined();
  });

  it("attaches the additive attention summary when the daemon advertises attention (#383)", () => {
    // An attention-capable context: needs-you from the attention registry, running from the
    // in-flight-review registry — NOT pendingPatchsetId (staleness, deliberately ignored here).
    const attentiveCtx = {
      ...ctx,
      reviewNeedsYou: (reviewId: string) => reviewId === "r1",
      reviewIsRunning: (reviewId: string) => reviewId === "r1",
    };
    // r1: needs-you + running, and a pendingPatchsetId that must NOT influence `running`.
    const out = projectCommandOutput(
      "review.capture",
      { review: { ...review, pendingPatchsetId: "ps2" } },
      attentiveCtx,
    ) as { review: Record<string, unknown> };
    expect(out.review.attention).toEqual({ needsYou: true, running: true });

    // r2: no active attention, not in flight — all-false even with pendingPatchsetId set.
    const quiet = projectCommandOutput(
      "review.capture",
      { review: { ...review, id: "r2", pendingPatchsetId: "ps9" } },
      attentiveCtx,
    ) as { review: Record<string, unknown> };
    expect(quiet.review.attention).toEqual({ needsYou: false, running: false });
  });

  it("projects a project list output", () => {
    const out = projectCommandOutput(
      "projects.list",
      {
        projects: [
          {
            id: "1",
            name: "rennet",
            path: REPO,
            kind: "repo",
            repoCount: 1,
            branchCount: 1,
            primaryBranch: "main",
            openPath: REPO,
            includedRepoPaths: [REPO],
            addedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      ctx,
    ) as { projects: { path: { repoKey: string }; openPath: { repoKey: string } }[] };
    const p0 = out.projects[0];
    expect(p0?.path.repoKey).toBeTruthy();
    expect(p0?.openPath.repoKey).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain(REPO);
  });

  it("projects repository.choose top-level path", () => {
    const out = projectCommandOutput("repository.choose", { path: REPO }, ctx) as {
      path: { repoKey: string };
    };
    expect(out.path.repoKey).toBeTruthy();
    const none = projectCommandOutput("repository.choose", { path: null }, ctx) as { path: null };
    expect(none.path).toBeNull();
  });

  it("scrubs known roots and home dir in free text", () => {
    expect(scrubRoots(`built ${REPO}/src`, ctx)).toBe("built <rennet>/src");
    expect(scrubRoots(`home is ${HOME}/x`, ctx)).toBe("home is ~/x");
  });

  it("redacts absolute paths a root/home substitution missed (#382 M2 finding 8)", () => {
    // A leftover absolute path outside every known root — redacted.
    expect(redactAbsolutePaths("ENOENT open /etc/passwd here")).toBe("ENOENT open <path> here");
    expect(redactAbsolutePaths("failed at /var/lib/thing/x.db")).toBe("failed at <path>");
    expect(redactAbsolutePaths("C:\\Users\\rai\\secret.txt bad")).toBe("<path> bad");
    // A URL, a `<root>`-scrubbed remainder, and a `~/…` home path are left intact.
    expect(redactAbsolutePaths("see https://example.com/a/b")).toBe("see https://example.com/a/b");
    expect(redactAbsolutePaths("built <rennet>/src/a.ts")).toBe("built <rennet>/src/a.ts");
    expect(redactAbsolutePaths("home is ~/x/y")).toBe("home is ~/x/y");
  });

  it("projects a progress event's summary path and scrubs its detail", () => {
    const event = projectProgressEvent(
      { kind: "repo-done", repo: "rennet", summary: { repo: "rennet", path: REPO, ok: true } },
      ctx,
    ) as unknown as { summary: { path: { repoKey: string } } };
    expect(event.summary.path.repoKey).toBeTruthy();
  });
});

describe("inbound resolution", () => {
  it("resolves a repoKey back to the exact host path a private client would name", () => {
    const ref = toRepoReference(REPO, ctx);
    const resolved = resolveCommandInput(
      "review.capture",
      { commandId: "c", repoPath: ref.repoKey },
      ctx,
    ) as { repoPath: string };
    expect(resolved.repoPath).toBe(REPO);
  });

  it("accepts a full reference object too", () => {
    const ref = toRepoReference(OTHER, ctx);
    const resolved = resolveCommandInput(
      "project.discover",
      { commandId: "c", path: ref, kind: "repo" },
      ctx,
    ) as { path: string };
    expect(resolved.path).toBe(OTHER);
  });

  it("throws ProjectionResolveError on an unknown reference", () => {
    expect(() =>
      resolveCommandInput("review.capture", { commandId: "c", repoPath: "not-a-real-key" }, ctx),
    ).toThrow(ProjectionResolveError);
  });

  it("leaves a non-path command input untouched", () => {
    const input = { reviewId: "r", patchsetId: "p", path: "src/x.ts", disposition: null, body: "" };
    expect(resolveCommandInput("review.setDisposition", input, ctx)).toEqual(input);
  });

  it("round-trips projected discovery references through projects.add", () => {
    const projected = projectCommandOutput(
      "project.discover",
      {
        discovery: {
          path: REPO,
          kind: "workspace",
          repos: [{ name: "nested", path: `${REPO}/nested`, branches: 1 }],
          primaryBranch: "main",
        },
      },
      ctx,
    ) as { discovery: Record<string, unknown> };
    const resolved = resolveCommandInput(
      "projects.add",
      {
        commandId: "00000000-0000-4000-8000-000000000000",
        discovery: projected.discovery,
        includedRepos: ["nested"],
        primaryBranch: "main",
      },
      ctx,
    ) as { discovery: { path: string; repos: { path: string }[] } };

    expect(resolved.discovery.path).toBe(REPO);
    expect(resolved.discovery.repos[0]?.path).toBe(`${REPO}/nested`);
  });

  it.each([
    {
      label: "discovery root",
      path: REPO,
      repoPath: toRepoReference(REPO, ctx),
    },
    {
      label: "discovered repo",
      path: toRepoReference(REPO, ctx),
      repoPath: REPO,
    },
  ])("rejects a raw absolute $label in projected projects.add input", ({ path, repoPath }) => {
    expect(() =>
      resolveCommandInput(
        "projects.add",
        {
          discovery: {
            path,
            kind: "repo",
            repos: [{ name: "rennet", path: repoPath, branches: 1 }],
            primaryBranch: "main",
          },
        },
        ctx,
      ),
    ).toThrow(ProjectionResolveError);
  });

  it("projects SettingsProject.repoPath and resolves the reference for settings.guidance", () => {
    const settingsProject = {
      projectId: "p1",
      name: "rennet",
      repoPath: REPO,
      visibility: "local",
      visibilityProvenance: { layer: "builtin", contributions: [] },
      promoted: false,
      promotedProvenance: { layer: "builtin", contributions: [] },
      locus: { kind: "host" },
      locusOverridden: false,
      configMalformed: false,
    };
    const projected = projectCommandOutput(
      "settings.get",
      {
        scheme: "system",
        schemeProvenance: { layer: "builtin", contributions: [] },
        appearanceMalformed: false,
        projects: [settingsProject],
      },
      ctx,
    ) as { projects: { repoPath: { repoKey: string } }[] };
    const reference = projected.projects[0]?.repoPath;

    expect(reference?.repoKey).toBeTruthy();
    expect(reference?.repoKey).not.toBe("undefined");
    const resolved = resolveCommandInput(
      "settings.guidance",
      { projectId: "p1", repoPath: reference },
      ctx,
    ) as { repoPath: string };
    expect(resolved.repoPath).toBe(REPO);
  });

  it.each(["settings.setRepoLocus", "settings.resetRepoValue", "settings.pinRepoValue"] as const)(
    "projects the SettingsProject row returned by %s",
    (command) => {
      const output = projectCommandOutput(
        command,
        { project: { projectId: "p1", name: "rennet", repoPath: REPO } },
        ctx,
      ) as { project: { repoPath: { repoKey: string } } };
      expect(output.project.repoPath.repoKey).toBeTruthy();
      expect(output.project.repoPath.repoKey).not.toBe("undefined");
    },
  );
});

type PathClassification = "host-path-projected" | "repo-relative" | "opaque";

type SchemaDef = {
  readonly type?: string;
  readonly shape?: Record<string, z.ZodType> | (() => Record<string, z.ZodType>);
  readonly element?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly out?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly items?: readonly z.ZodType[];
  readonly rest?: z.ZodType;
  readonly valueType?: z.ZodType;
};

const PATH_LIKE_FIELD_NAMES = new Set([
  "path",
  "repoPath",
  "openPath",
  "root",
  "commonDir",
  "repositoryRoot",
  "includedRepoPaths",
]);

function schemaDef(schema: z.ZodType): SchemaDef {
  return (schema as unknown as { _zod: { def: SchemaDef } })._zod.def;
}

function schemaChildren(schema: z.ZodType): readonly z.ZodType[] {
  const def = schemaDef(schema);
  switch (def.type) {
    case "array":
      return def.element ? [def.element] : [];
    case "optional":
    case "nullable":
    case "default":
      return def.innerType ? [def.innerType] : [];
    case "pipe":
      return [def.in, def.out].filter((child): child is z.ZodType => child !== undefined);
    case "union":
      return def.options ?? [];
    case "tuple":
      return [...(def.items ?? []), ...(def.rest ? [def.rest] : [])];
    case "record":
      return def.valueType ? [def.valueType] : [];
    default:
      return [];
  }
}

function containsString(schema: z.ZodType, seen = new Set<z.ZodType>()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (schemaDef(schema).type === "string") return true;
  return schemaChildren(schema).some((child) => containsString(child, seen));
}

function collectPathFields(
  schema: z.ZodType,
  location: string,
  found: Set<string>,
  seen = new Set<z.ZodType>(),
): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = schemaDef(schema);
  if (def.type === "object") {
    const shape = typeof def.shape === "function" ? def.shape() : def.shape;
    for (const [field, child] of Object.entries(shape ?? {})) {
      const childLocation = `${location}.${field}`;
      if (PATH_LIKE_FIELD_NAMES.has(field) && containsString(child)) found.add(childLocation);
      collectPathFields(child, childLocation, found, new Set(seen));
    }
    return;
  }
  for (const child of schemaChildren(schema)) {
    collectPathFields(child, location, found, new Set(seen));
  }
}

function classified(
  classification: PathClassification,
  locations: readonly string[],
): Record<string, PathClassification> {
  return Object.fromEntries(locations.map((location) => [location, classification]));
}

function reviewShape(prefix: string): Record<string, PathClassification> {
  return {
    ...classified("host-path-projected", [
      `${prefix}.repositoryRoot`,
      `${prefix}.patchsets.repository.root`,
      `${prefix}.patchsets.repository.commonDir`,
    ]),
    ...classified("repo-relative", [
      `${prefix}.patchsets.files.path`,
      `${prefix}.patchsets.intent.specSnapshots.path`,
      `${prefix}.dispositions.anchor.path`,
      `${prefix}.orphaned.anchor.path`,
      `${prefix}.successorAccount.asks.path`,
      `${prefix}.successorAccount.beyondAskHunks.path`,
    ]),
  };
}

function projectShape(prefix: string): Record<string, PathClassification> {
  return classified("host-path-projected", [
    `${prefix}.path`,
    `${prefix}.openPath`,
    `${prefix}.includedRepoPaths`,
  ]);
}

const PATH_FIELD_CLASSIFICATIONS: Readonly<Record<string, PathClassification>> = {
  ...reviewShape("app.bootstrap.output.review"),
  ...reviewShape("review.capture.output.review"),
  ...reviewShape("review.openPr.output.review"),
  ...reviewShape("review.load.output.review"),
  ...reviewShape("review.setDisposition.output.review"),
  ...reviewShape("review.checkFreshness.output.review"),
  ...reviewShape("review.regenerate.output.review"),
  ...reviewShape("review.handoff.run.output.result.review"),
  ...projectShape("projects.list.output.projects"),
  ...projectShape("projects.add.output.project"),
  ...projectShape("projects.add.output.projects"),
  ...projectShape("projects.remove.output.projects"),
  ...classified("host-path-projected", [
    "repository.choose.input.path",
    "repository.choose.output.path",
    "review.capture.input.repoPath",
    "review.openPr.input.repoPath",
    "review.checkFreshness.input.repoPath",
    "review.regenerate.input.repoPath",
    "project.discover.input.path",
    "project.discover.output.discovery.path",
    "project.discover.output.discovery.repos.path",
    "projects.add.input.discovery.path",
    "projects.add.input.discovery.repos.path",
    "project.process.output.repos.path",
    "settings.get.output.projects.repoPath",
    "settings.guidance.input.repoPath",
    "settings.setRepoVisibility.input.repoPath",
    "settings.setRepoLocus.input.repoPath",
    "settings.setRepoLocus.output.project.repoPath",
    "settings.resetRepoValue.input.repoPath",
    "settings.resetRepoValue.output.project.repoPath",
    "settings.pinRepoValue.input.repoPath",
    "settings.pinRepoValue.output.project.repoPath",
    "progressEvent.summary.path",
    "progressEvent.repos.path",
    // The reviewed PR's worktree lives under MAIN's data dir — a host path the
    // renderer shows and a remote projection must translate like any other root.
    "review.prWorktree.output.worktree.path",
    // fs.listDir (the ungated filesystem browser) walks the daemon's own host
    // filesystem — every path here is host-absolute like repository.choose's.
    "fs.listDir.input.path",
    "fs.listDir.output.result.path",
    "fs.listDir.output.result.entries.path",
  ]),
  ...classified("repo-relative", [
    "review.setDisposition.input.path",
    "publish.review.input.comments.path",
    "publish.review.output.ledger.path",
    "publish.compose.output.comments.path",
    "flagged.review.output.uiVerification.screenshots.path",
    "flagged.review.output.blockingStates.path",
    "flagged.adjudication.output.review.uiVerification.screenshots.path",
    "flagged.adjudication.output.review.blockingStates.path",
    "review.uiEvidence.input.path",
    "review.ask.input.anchor.path",
    "review.reattach.output.threads.anchor.path",
    "review.refine.input.path",
    "review.draftPrBody.input.dispositions.path",
    "review.symbolLookup.output.definition.sites.path",
    "review.symbolLookup.output.references.sites.path",
    "review.symbolLookup.output.neighbors.path",
    "review.openInEditor.input.path",
    "review.handoff.prepare.input.dispositions.path",
    "review.handoff.prepare.output.bundle.tasks.path",
    "review.handoff.run.input.bundle.tasks.asks.path",
    "review.handoff.compose.input.dispositions.path",
    "review.handoff.compose.output.bundle.tasks.asks.path",
    // The Context Map surface (add-context-map-view): every path in the Repo Map, the
    // knowledge set, and a context-ask answer is a git-blob path relative to the repo
    // root — never a host-absolute path, so no remote projection translates them.
    "project.contextMap.output.map.files.path",
    "project.contextMap.output.map.scopes.root",
    "project.contextMap.output.map.tests.path",
    "project.contextMap.output.map.conventions.path",
    "project.contextMap.output.knowledge.statements.evidence.path",
    "project.contextAsk.output.answer.evidence.path",
    "project.knowledgeDisposition.output.statement.evidence.path",
  ]),
  ...classified("opaque", [
    "project.detail.output.locals.id",
    "project.detail.output.prs.id",
    "project.cleanupWorktree.input.worktreeId",
  ]),
};

describe("recursive path-field coverage guard", () => {
  it("classifies every path-like string in every command input/output and pushed event", () => {
    const found = new Set<string>();
    for (const [command, definition] of Object.entries(commandDefinitions)) {
      collectPathFields(definition.input, `${command}.input`, found);
      collectPathFields(definition.output, `${command}.output`, found);
    }
    collectPathFields(projectProcessEventSchema, "progressEvent", found);
    collectPathFields(reviewAskStreamEventSchema, "askStreamEvent", found);

    expect(found).toContain("projects.add.input.discovery.repos.path");
    expect(found).toContain("settings.get.output.projects.repoPath");
    expect(found).toContain("review.ask.input.anchor.path");
    const unclassified = [...found]
      .filter((location) => PATH_FIELD_CLASSIFICATIONS[location] === undefined)
      .sort();
    expect(
      unclassified,
      `classify every new path location as host-path-projected, repo-relative, or opaque: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the runtime inbound tables aligned with their classified top-level fields", () => {
    expect(INBOUND_HOST_PATH_FIELDS["review.capture"]).toContain("repoPath");
    expect(INBOUND_REPO_RELATIVE_PATH_FIELDS["review.setDisposition"]).toContain("path");
  });
});
