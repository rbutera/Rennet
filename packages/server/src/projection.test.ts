import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands, projectProcessEventSchema, RoundEventSchema } from "@rennet/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  buildProjectionContext,
  createCachedProjectionContext,
  INBOUND_HOST_PATH_FIELDS,
  INBOUND_REPO_RELATIVE_PATH_FIELDS,
  ProjectionResolveError,
  projectBoardEvent,
  projectBoardProjection,
  projectCommandOutput,
  projectProgressEvent,
  redactAbsolutePaths,
  resolveCommandInput,
  scrubProjectedValue,
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

  it("keeps a clean publish composition byte-exact across the paired-device projection", () => {
    const composition = {
      status: "review",
      artifact: {
        opener: "The retry boundary is ready to post.",
        comments: [],
        bodyNotes: [],
      },
      post: {
        event: "APPROVE",
        body: "The retry boundary is ready to post.\n\n<!-- rennet:review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
        threads: [],
      },
      ledger: [],
      payload:
        '{"kind":"pr-review","opener":"The retry boundary is ready to post.","comments":[],"bodyNotes":[]}',
      destination: "rbutera/rennet#621",
      title: "rbutera/rennet#621",
      compositionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };

    expect(projectCommandOutput("publish.compose", composition, ctx)).toEqual(composition);
  });

  it("treats host-looking publish prose as opaque signed content instead of mutating it", () => {
    const composition = {
      status: "review",
      artifact: {
        opener: `The retry is implemented in ${REPO}/packages/server/src/retry.ts.`,
        comments: [],
        bodyNotes: [
          {
            id: "note-1",
            type: "comment",
            body: "Keep the local reproduction attached.",
            anchor: "Design · Retry reproduction",
          },
        ],
      },
      post: { event: "COMMENT", body: "body", threads: [] },
      ledger: [],
      payload: "canonical bytes bound before projection",
      destination: "rbutera/rennet#621",
      title: "rbutera/rennet#621",
      compositionId: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    };

    expect(projectCommandOutput("publish.compose", composition, ctx)).toEqual(composition);
  });

  it("redacts local paths from an unavailable publish composition", () => {
    const unavailable = {
      status: "unavailable",
      reason: `Could not persist ${REPO}/draft.json after reading /var/private/model.log`,
      retryable: true,
    };

    const projected = projectCommandOutput(
      "publish.compose",
      unavailable,
      ctx,
    ) as typeof unavailable;
    expect(projected).toEqual({
      status: "unavailable",
      reason: "Could not persist <rennet>/draft.json after reading <path>",
      retryable: true,
    });
    expect(JSON.stringify(projected)).not.toContain(REPO);
    expect(JSON.stringify(projected)).not.toContain("/var/private/model.log");
  });

  it("detects a Windows host root even though the canonical payload JSON escapes it", () => {
    const root = "C:\\Users\\rai\\dev\\rennet";
    const windows = buildProjectionContext([root], "C:\\Users\\rai");
    const opener = `The retry is implemented in ${root}\\packages\\server\\src\\retry.ts.`;
    const composition = {
      status: "review",
      artifact: { opener, comments: [], bodyNotes: [] },
      post: { event: "COMMENT", body: opener, threads: [] },
      ledger: [],
      payload: JSON.stringify({ kind: "pr-review", opener, comments: [], bodyNotes: [] }),
      destination: "rbutera/rennet#621",
      title: "rbutera/rennet#621",
      compositionId: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    };

    expect(projectCommandOutput("publish.compose", composition, windows)).toEqual(composition);
  });

  // ── session.transcript: the display transcript is stored RAW, scrubbed HERE ──────
  //
  // The capture sink used to redact before `append`, which destroyed the reviewer's own
  // paths on their own disk and bought nothing, because every read already crosses this
  // boundary. These two cases are the load-bearing half of that move: they are what stands
  // between a raw stored row and a phone. Delete the `session.transcript` branch in
  // `projectCommandOutput` and both go red.

  /** One stored row exactly as the capture sink now writes it: harness text, host paths intact. */
  const rawTranscript = {
    trail: { title: "feat/seam" },
    rows: [
      {
        kind: "turn",
        id: "turn-1",
        speaker: "orchestrator",
        status: "complete",
        paragraphs: [`wrote ${REPO}/packages/server/src/x.ts`],
        preface: [
          {
            kind: "action",
            id: "act-1",
            label: "Bash",
            // Three shapes in one argument: a known root, the home dir, and an absolute path
            // under NEITHER — the last is the one a blanket root/home scrub cannot see.
            detail: `cat ${REPO}/src/a.ts ${HOME}/.zshrc /etc/hosts/passwd`,
            status: "complete",
            toolKind: "exec",
          },
        ],
        body: [{ kind: "code", path: `${REPO}/src/a.ts`, code: "const a = 1;" }],
      },
    ],
  };

  it("scrubs a raw stored transcript on the way out to a PROJECTED client", () => {
    const out = projectCommandOutput("session.transcript", rawTranscript, ctx);
    const serialized = JSON.stringify(out);
    // The two needles the remote must never see.
    expect(serialized).not.toContain(REPO);
    expect(serialized).not.toContain(HOME);
    // Known root and home become display tokens; the stray absolute path is redacted whole.
    expect(serialized).toContain("<rennet>/src/a.ts");
    expect(serialized).toContain("~/.zshrc");
    expect(serialized).toContain("<path>");
    expect(serialized).not.toContain("/etc/hosts/passwd");
  });

  it("the row scrub is what catches the stray path — the blanket root scrub alone does not", () => {
    // Positive control on the CONTROL: `scrubRoots` is the blanket pass every command output
    // gets, and it leaves `/etc/hosts/passwd` untouched. So the assertion above is testing the
    // `session.transcript` branch specifically, not the pass that would have run anyway.
    expect(scrubRoots("/etc/hosts/passwd", ctx)).toBe("/etc/hosts/passwd");
    expect(redactAbsolutePaths("/etc/hosts/passwd")).toBe("<path>");
    // And the branch is command-scoped: the same payload under a DIFFERENT command name keeps
    // the stray path, which is exactly why the branch has to exist.
    const other = JSON.stringify(projectCommandOutput("session.rounds", rawTranscript, ctx));
    expect(other).toContain("/etc/hosts/passwd");
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

  it("scrubs host paths from a scoped round-report progress frame", () => {
    const event = RoundEventSchema.parse({
      type: "report",
      reportBoardId: "report-1",
      operationId: "operation-1",
      operationRevision: 3,
      report: {
        lens: "report",
        generation: "generation-1",
        boardId: "report-1",
        document: {
          title: "Round report",
          introMarkdown: `Changed ${REPO}/src/auth.ts.`,
          measure: "reading",
          sources: [{ path: `${REPO}/src/auth.ts`, label: "auth" }],
        },
        sections: [],
        elements: [
          {
            id: "code-1",
            kind: "code_ref",
            data: {
              author: { kind: "lens-agent", id: "round-report" },
              patchset_id: "patchset-1",
              path: `${REPO}/src/auth.ts`,
              side: "head",
              start_line: 1,
              end_line: 1,
            },
          },
        ],
      },
    });

    const projected = JSON.stringify(scrubProjectedValue(event, ctx));
    expect(projected).not.toContain(REPO);
    expect(projected).toContain("<rennet>/src/auth.ts");
  });
});

// B4: the packet's positive control — a board payload carrying an absolute host
// path and a home-dir string must come out of the wrap substituted. A scrub
// bypass (identity wrap) makes every assertion here fail.
describe("board privacy wrap (B4)", () => {
  const event = {
    seq: 1,
    actor: "lens:design",
    op: {
      op: "create" as const,
      op_id: "op-1",
      element: {
        id: "f1",
        kind: "finding",
        data: {
          author: { kind: "lens-agent", id: "lens:design" },
          concern: `The loader reads ${REPO}/packages/server/src/x.ts before init.`,
          note: `${HOME}/notes/scratch.md has the repro`,
        },
      },
    },
  };

  it("projectBoardEvent substitutes known roots and the home dir in every string", () => {
    const projected = projectBoardEvent(event, ctx) as typeof event;
    const text = JSON.stringify(projected);
    expect(text).not.toContain(REPO);
    expect(text).not.toContain(HOME);
    expect(projected.op.element.data.concern).toBe(
      "The loader reads <rennet>/packages/server/src/x.ts before init.",
    );
    expect(projected.op.element.data.note).toBe("~/notes/scratch.md has the repro");
    // Non-string structure is untouched.
    expect(projected.seq).toBe(1);
    expect(projected.op.op_id).toBe("op-1");
  });

  it("projectBoardProjection substitutes in projected element state", () => {
    const elements = [
      { id: "f1", kind: "finding", data: { concern: `${REPO}/README.md`, home: HOME } },
    ];
    const projected = projectBoardProjection(elements, ctx) as typeof elements;
    expect(JSON.stringify(projected)).not.toContain(REPO);
    expect(projected[0]?.data.concern).toBe("<rennet>/README.md");
    expect(projected[0]?.data.home).toBe("~");
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

  it.each(["settings.resetRepoValue", "settings.pinRepoValue"] as const)(
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
  ...projectShape("project.rename.output.project"),
  ...projectShape("project.rename.output.projects"),
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
    "project.process.output.run.repos.path",
    "settings.get.output.projects.repoPath",
    "settings.guidance.input.repoPath",
    "settings.setRepoVisibility.input.repoPath",
    "settings.resetRepoValue.input.repoPath",
    "settings.resetRepoValue.output.project.repoPath",
    "settings.pinRepoValue.input.repoPath",
    "settings.pinRepoValue.output.project.repoPath",
    "settings.setProjectValue.input.repoPath",
    "settings.setProjectValue.output.project.repoPath",
    "settings.setGuidance.input.repoPath",
    "progressEvent.summary.path",
    "progressEvent.repos.path",
    "progressEvent.run.repos.path",
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
    "progressEvent.report.elements.data.path",
    "progressEvent.report.document.sources.path",
    "progressEvent.report.elements.data.source.path",
    "progressEvent.report.elements.data.sources.path",
    "session.roundEvents.output.events.report.elements.data.path",
    "session.roundEvents.output.events.report.document.sources.path",
    "session.roundEvents.output.events.report.elements.data.source.path",
    "session.roundEvents.output.events.report.elements.data.sources.path",
    // The span-read row (B3, #489): a CodeRef citation's path is repo-relative
    // within the captured patchset.
    "patchset.readSpan.input.path",
    "review.setDisposition.input.path",
    "publish.review.input.artifact.comments.path",
    "publish.review.input.post.threads.path",
    "publish.review.output.ledger.path",
    "publish.compose.output.artifact.comments.path",
    "publish.compose.output.post.threads.path",
    "publish.compose.output.ledger.path",
    "flagged.review.output.uiVerification.screenshots.path",
    "flagged.review.output.blockingStates.path",
    "flagged.adjudication.output.review.uiVerification.screenshots.path",
    "flagged.adjudication.output.review.blockingStates.path",
    "review.uiEvidence.input.path",
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
    // The round exit (B11 cluster 4): the composed work-order's task asks carry the ask's
    // `path` — a code ask's repo-relative path (from its `path:line` anchor) or a prose
    // ask's quoted anchor text. Never a host-absolute path, so no remote projection
    // translates it — the same shape/handling as the handoff-compose bundle above.
    "round.dispatch.output.workOrder.tasks.asks.path",
    // knowledge set, and a context-ask answer is a git-blob path relative to the repo
    // root — never a host-absolute path, so no remote projection translates them.
    // Durable asks (B11): per-line comments and canonical CodeRefs point into the
    // reviewed repository, never the host filesystem. Every write echoes an
    // `AskEventBody`, so both path-bearing variants surface on every receipt schema.
    "ask.setLineComment.input.path",
    "ask.clearLineComment.input.path",
    "ask.stage.input.ask.codeRef.path",
    "ask.stage.output.receipt.path",
    "ask.stage.output.receipt.ask.codeRef.path",
    "ask.unstage.output.receipt.path",
    "ask.unstage.output.receipt.ask.codeRef.path",
    "ask.dismissFinding.output.receipt.path",
    "ask.dismissFinding.output.receipt.ask.codeRef.path",
    "ask.restoreFinding.output.receipt.path",
    "ask.restoreFinding.output.receipt.ask.codeRef.path",
    "ask.edit.output.receipt.path",
    "ask.edit.output.receipt.ask.codeRef.path",
    "ask.retire.output.receipt.path",
    "ask.retire.output.receipt.ask.codeRef.path",
    "ask.restore.output.receipt.path",
    "ask.restore.output.receipt.ask.codeRef.path",
    "ask.quoteOpen.output.receipt.path",
    "ask.quoteOpen.output.receipt.ask.codeRef.path",
    "ask.quoteReply.output.receipt.path",
    "ask.quoteReply.output.receipt.ask.codeRef.path",
    "ask.quoteClose.output.receipt.path",
    "ask.quoteClose.output.receipt.ask.codeRef.path",
    "ask.setVerdictOverride.output.receipt.path",
    "ask.setVerdictOverride.output.receipt.ask.codeRef.path",
    "ask.setLineComment.output.receipt.path",
    "ask.setLineComment.output.receipt.ask.codeRef.path",
    "ask.clearLineComment.output.receipt.path",
    "ask.clearLineComment.output.receipt.ask.codeRef.path",
    "ask.read.output.projection.stagedAsks.codeRef.path",
    "ask.read.output.projection.retired.ask.codeRef.path",
    // Span rework (B11 cluster 5) echoes the same `AskEventBody` receipt (its
    // `ask.edit` write), so both receipt path variants are repo-relative too.
    "review.reviseSpan.output.receipt.path",
    "review.reviseSpan.output.receipt.ask.codeRef.path",
  ]),
  ...classified("host-path-projected", [
    // The display transcript (issue-set B): a coding turn's `code` body block cites the file it
    // touched, and the transcript is now stored RAW — the capture sink no longer redacts, because
    // the log is the reviewer's own, on their own disk. So this path CAN be host-absolute at rest,
    // and `projectCommandOutput`'s `session.transcript` branch is what translates it for a
    // projected connection (scrub roots/home, then redact any leftover absolute path). Same
    // treatment as the free-text a projected `rpcError` carries — the row content is harness text.
    "session.transcript.output.rows.blocks.path",
    "session.transcript.output.rows.body.path",
  ]),
  ...classified("repo-relative", [
    // The lens-board read (C18): a board's `code_ref` elements cite the CAPTURED patchset by
    // repo-relative path (`codeRefSchema`'s own field, the same one `review.setDisposition`
    // carries). Design source chips use the same reviewed-repository coordinate space —
    // never a host-absolute path, so no remote projection translates any of them.
    "board.read.output.board.elements.data.path",
    "board.read.output.board.document.sources.path",
    "board.read.output.board.elements.data.source.path",
    "board.read.output.board.elements.data.sources.path",
    // The round diff (#571): the ledger read splits `RoundRecord.diff` — a `git diff` run
    // INSIDE the repo — into per-file patches, so each `path` is the `diff --git a/… b/…`
    // header's repo-relative path, exactly like a patchset's `files.path` above. Never
    // host-absolute, so no remote projection translates it.
    "session.rounds.output.records.diffFiles.path",
    // The exact round-report projection embeds the same repo-relative code refs and source
    // chips as `board.read`; it is joined into the ledger by durable board id, not rewritten.
    "session.rounds.output.records.report.elements.data.path",
    "session.rounds.output.records.report.document.sources.path",
    "session.rounds.output.records.report.elements.data.source.path",
    "session.rounds.output.records.report.elements.data.sources.path",
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
    for (const [command, definition] of Object.entries(commands)) {
      collectPathFields(definition.args, `${command}.input`, found);
      collectPathFields(definition.output, `${command}.output`, found);
    }
    collectPathFields(projectProcessEventSchema, "progressEvent", found);
    collectPathFields(RoundEventSchema, "progressEvent", found);

    expect(found).toContain("projects.add.input.discovery.repos.path");
    expect(found).toContain("settings.get.output.projects.repoPath");
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

describe("createCachedProjectionContext (perf audit §4 H3)", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function projectsFile(contents?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "rennet-projection-"));
    scratch.push(dir);
    const path = join(dir, "projects.json");
    if (contents !== undefined) writeFileSync(path, contents);
    return path;
  }

  const projectAt = (path: string) => ({ path, openPath: path });

  it("reads the projects once across repeated calls and serves the same roots", () => {
    const projectsPath = projectsFile('{"projects":[]}\n');
    const listProjects = vi.fn(() => [projectAt(REPO)]);
    const contextOf = createCachedProjectionContext({
      listProjects,
      grantedRoots: new Set<string>(),
      projectsPath,
      homeDir: HOME,
    });

    const first = contextOf();
    const second = contextOf();
    const third = contextOf();
    // One read of the project store, not three — this ran per projected frame, which is
    // per streamed ask token with a phone paired.
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(second.roots.map((r) => r.hostPath)).toEqual(first.roots.map((r) => r.hostPath));
    expect(third).toBe(first); // the identical built table, not a re-derived twin
  });

  it("invalidates when projects.json changes on disk, whoever wrote it", () => {
    // The control in the other direction, and the reason the key is the FILE's identity
    // rather than a hook at each `projectStore` mutation: a site is easy to add and forget,
    // and a second process writing the file would be missed entirely.
    const projectsPath = projectsFile('{"projects":[]}\n');
    let projects = [projectAt(REPO)];
    const listProjects = vi.fn(() => projects);
    const contextOf = createCachedProjectionContext({
      listProjects,
      grantedRoots: new Set<string>(),
      projectsPath,
      homeDir: HOME,
    });

    expect(contextOf().byRepoKey.size).toBe(1);
    projects = [projectAt(REPO), projectAt(OTHER)];
    writeFileSync(projectsPath, '{"projects":[{"stand-in":true}]}\n');

    const after = contextOf();
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(after.roots.map((r) => r.hostPath).sort()).toEqual([OTHER, REPO].sort());
  });

  it("invalidates when the granted-roots set grows", () => {
    // `allowedRoots` is append-only in `create-server`, so its size is its version. A review
    // whose repository root was just granted must be nameable on the next frame.
    const projectsPath = projectsFile('{"projects":[]}\n');
    const granted = new Set<string>();
    const listProjects = vi.fn(() => [] as { path: string; openPath: string }[]);
    const contextOf = createCachedProjectionContext({
      listProjects,
      grantedRoots: granted,
      projectsPath,
      homeDir: HOME,
    });

    expect(contextOf().roots).toEqual([]);
    granted.add(REPO);
    expect(contextOf().roots.map((r) => r.hostPath)).toEqual([REPO]);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("caches the empty-workspace answer too, with no projects.json on disk", () => {
    const projectsPath = projectsFile(); // never written
    const listProjects = vi.fn(() => [] as { path: string; openPath: string }[]);
    const contextOf = createCachedProjectionContext({
      listProjects,
      grantedRoots: new Set<string>(),
      projectsPath,
      homeDir: HOME,
    });
    contextOf();
    contextOf();
    expect(listProjects).toHaveBeenCalledTimes(1);
  });
});
