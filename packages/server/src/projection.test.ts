import { homedir } from "node:os";
import { commandDefinitions } from "@rennet/protocol";
import { describe, expect, it } from "vitest";
import {
  buildProjectionContext,
  INBOUND_HOST_PATH_FIELDS,
  INBOUND_REPO_RELATIVE_PATH_FIELDS,
  ProjectionResolveError,
  projectCommandOutput,
  projectProgressEvent,
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
});

describe("path-field coverage guard (no new path field slips through)", () => {
  it("classifies every top-level repoPath/path input field as host or repo-relative", () => {
    const unclassified: string[] = [];
    for (const [command, def] of Object.entries(commandDefinitions)) {
      const shape = (def.input as { shape?: Record<string, unknown> }).shape;
      if (!shape) continue;
      for (const field of Object.keys(shape)) {
        if (field !== "path" && field !== "repoPath") continue;
        const host = INBOUND_HOST_PATH_FIELDS[command]?.includes(field);
        const rel = INBOUND_REPO_RELATIVE_PATH_FIELDS[command]?.includes(field);
        if (!host && !rel) unclassified.push(`${command}.${field}`);
      }
    }
    expect(
      unclassified,
      `classify these into INBOUND_HOST_PATH_FIELDS or INBOUND_REPO_RELATIVE_PATH_FIELDS in projection.ts: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });
});
