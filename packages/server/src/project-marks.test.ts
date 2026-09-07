import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDetectedLogo, ProjectSnapshotStore } from "@rennet/adapters";
import { escapePath } from "@rennet/core";
import type { Project, SettingsProjectWriteOutcome } from "@rennet/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectMarks, type ProjectMarkDeps } from "./project-marks";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "marks-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(root: string, path: string, body = "x"): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "orbital",
    path: "/orbital",
    kind: "repo",
    repoCount: 1,
    branchCount: 1,
    primaryBranch: "main",
    openPath: "/orbital",
    addedAt: "2026-09-07T00:00:00.000Z",
    source: "local",
    ...overrides,
  };
}

const applied = (): SettingsProjectWriteOutcome => ({
  status: "applied",
  key: "mark",
  project: null,
});

function makeDeps(overrides: Partial<ProjectMarkDeps> = {}): {
  deps: ProjectMarkDeps;
  writes: { projectId: string; repoPath: string; key: string; value: string | null }[];
  detects: { repoKey: string; repoRoot: string }[];
} {
  const writes: { projectId: string; repoPath: string; key: string; value: string | null }[] = [];
  const detects: { repoKey: string; repoRoot: string }[] = [];
  const deps: ProjectMarkDeps = {
    store: new ProjectSnapshotStore(tempDir()),
    listProjects: () => [project()],
    // The identity every verb resolves through: a working path → its git top level.
    gitTopLevel: async (workingPath) => workingPath,
    discoverWorkspaceRepos: async () => [],
    detectLogoForRepo: async (input) => {
      detects.push(input);
      return null;
    },
    setProjectValue: async (input) => {
      writes.push(input);
      return applied();
    },
    ...overrides,
  };
  return { deps, writes, detects };
}

describe("project.logos", () => {
  it("reads both kinds for a project, and omits a kind the project has no file for", async () => {
    const { deps } = makeDeps();
    const repo = tempDir();
    file(repo, "logo.svg", "<svg/>");
    copyDetectedLogo(deps.store, escapePath("/orbital"), repo, "logo.svg");

    const { logos } = await createProjectMarks(deps).logos({});
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({
      projectId: "p1",
      logo: "detected",
      mimeType: "image/svg+xml",
      source: "logo.svg",
    });
    expect(Buffer.from(logos[0]?.bytesBase64 ?? "", "base64").toString("utf8")).toBe("<svg/>");
  });

  it("a project with no logo file contributes no rows", async () => {
    const { deps } = makeDeps();
    expect((await createProjectMarks(deps).logos({})).logos).toEqual([]);
  });

  it("finds a workspace's logo under ANY included repo, not only the first", async () => {
    // Same shape as the settings ladder's cross-repo offer: the scout files a copy under
    // the repo it scouted, so reading only the first repo's key returns nothing while the
    // project really does have a mark. Nothing errors — the sidebar just shows a glyph.
    const workspace = project({
      kind: "workspace",
      path: "/work",
      openPath: "/work/api",
      includedRepoPaths: ["/work/api", "/work/web"],
      repoCount: 2,
    });
    const { deps } = makeDeps({ listProjects: () => [workspace] });
    const repo = tempDir();
    file(repo, "logo.png", "png");
    copyDetectedLogo(deps.store, escapePath("/work/web"), repo, "logo.png");

    const { logos } = await createProjectMarks(deps).logos({});
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ projectId: "p1", logo: "detected", mimeType: "image/png" });
    // The control: filed under a repo the project does NOT include, and it is invisible —
    // so the read above is the inclusion set talking, not a store-wide scan.
    const other = makeDeps({ listProjects: () => [workspace] }).deps;
    copyDetectedLogo(other.store, escapePath("/elsewhere"), repo, "logo.png");
    expect((await createProjectMarks(other).logos({})).logos).toEqual([]);
  });

  it("`projectId` narrows the read to one project", async () => {
    const second = project({ id: "p2", name: "atlas", path: "/atlas", openPath: "/atlas" });
    const { deps } = makeDeps({ listProjects: () => [project(), second] });
    const repo = tempDir();
    file(repo, "logo.svg");
    copyDetectedLogo(deps.store, escapePath("/orbital"), repo, "logo.svg");
    copyDetectedLogo(deps.store, escapePath("/atlas"), repo, "logo.svg");

    expect((await createProjectMarks(deps).logos({})).logos.map((row) => row.projectId)).toEqual([
      "p1",
      "p2",
    ]);
    expect(
      (await createProjectMarks(deps).logos({ projectId: "p2" })).logos.map((row) => row.projectId),
    ).toEqual(["p2"]);
  });
});

describe("project.uploadLogo", () => {
  it("stores the bytes AND sets the mark pref to upload, through the settings write", async () => {
    const { deps, writes } = makeDeps();
    const outcome = await createProjectMarks(deps).upload({
      projectId: "p1",
      mimeType: "image/png",
      bytesBase64: Buffer.from("png-bytes").toString("base64"),
      fileName: "acme.png",
    });
    expect(outcome.status).toBe("applied");
    // The pref went through the ORDINARY per-project write, addressed at the first repo —
    // the same rung and the same writer a user picking "upload" by hand would use.
    expect(writes).toEqual([
      { projectId: "p1", repoPath: "/orbital", key: "mark", value: "upload" },
    ]);
    // …and the bytes are readable back, so the pref does not point at a file that is not there.
    const { logos } = await createProjectMarks(deps).logos({ projectId: "p1" });
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ logo: "upload", mimeType: "image/png", source: "acme.png" });
  });

  it("an unknown project writes nothing and says so", async () => {
    const { deps, writes } = makeDeps({ listProjects: () => [] });
    const outcome = await createProjectMarks(deps).upload({
      projectId: "ghost",
      mimeType: "image/png",
      bytesBase64: "AAAA",
      fileName: "x.png",
    });
    expect(outcome).toEqual({ status: "unresolved", key: "mark", project: null });
    expect(writes).toEqual([]);
  });
});

describe("project.detectLogo", () => {
  it("asks every included repo in order and reports the first pick", async () => {
    const workspace = project({
      kind: "workspace",
      path: "/work",
      openPath: "/work/api",
      includedRepoPaths: ["/work/api", "/work/web"],
      repoCount: 2,
    });
    const { deps, detects } = makeDeps({
      listProjects: () => [workspace],
      detectLogoForRepo: async (input) => {
        detects.push(input);
        return input.repoRoot === "/work/web" ? { value: "public/mark.svg" } : null;
      },
    });
    expect(await createProjectMarks(deps).detect({ projectId: "p1" })).toEqual({
      found: true,
      source: "public/mark.svg",
    });
    expect(detects.map((entry) => entry.repoRoot)).toEqual(["/work/api", "/work/web"]);
    expect(detects[1]?.repoKey).toBe(escapePath("/work/web"));
  });

  it("reports `found: false` when no repo yields a mark", async () => {
    const { deps } = makeDeps();
    expect(await createProjectMarks(deps).detect({ projectId: "p1" })).toEqual({
      found: false,
      source: null,
    });
  });

  it("a repo whose checkout is gone is skipped, never detected against", async () => {
    const { deps, detects } = makeDeps({ gitTopLevel: async () => null });
    expect(await createProjectMarks(deps).detect({ projectId: "p1" })).toEqual({
      found: false,
      source: null,
    });
    expect(detects).toEqual([]);
  });
});
