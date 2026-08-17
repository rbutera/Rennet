import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveryResult } from "@rennet/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveProjectDraft, FileProjectStore, type ProjectDraft } from "./file-project-store";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rennet-projects-"));
  path = join(dir, "nested", "projects.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function draft(overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  return {
    name: "orbital",
    path: "/code/orbital",
    kind: "workspace",
    repoCount: 2,
    branchCount: 5,
    primaryBranch: "main",
    openPath: "/code/orbital/atlas",
    ...overrides,
  };
}

describe("FileProjectStore", () => {
  it("starts empty and creates its parent directory", () => {
    const store = new FileProjectStore(path);
    expect(store.list()).toEqual([]);
  });

  it("stamps id + addedAt and persists across instances", () => {
    let clock = 0;
    const store = new FileProjectStore(path, {
      id: () => "id-fixed",
      now: () => `2026-08-09T00:00:0${clock++}.000Z`,
    });
    const project = store.add(draft());
    expect(project.id).toBe("id-fixed");
    expect(project.addedAt).toBe("2026-08-09T00:00:00.000Z");
    expect(project.name).toBe("orbital");
    expect(project.openPath).toBe("/code/orbital/atlas");

    // A fresh store reads the same persisted record.
    const reopened = new FileProjectStore(path);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]?.id).toBe("id-fixed");
  });

  it("lists newest first", () => {
    let n = 0;
    const store = new FileProjectStore(path, {
      id: () => `id-${n}`,
      now: () => `2026-08-09T00:00:0${n++}.000Z`,
    });
    store.add(draft({ name: "first" }));
    store.add(draft({ name: "second" }));
    expect(store.list().map((p) => p.name)).toEqual(["second", "first"]);
  });

  it("degrades a corrupt store to an empty list, never a throw", () => {
    const store = new FileProjectStore(path); // the constructor creates the parent dir
    writeFileSync(path, "{ not json");
    expect(store.list()).toEqual([]);
  });

  it("drops a malformed entry but keeps its well-formed siblings", () => {
    const store = new FileProjectStore(path, {
      id: () => "good",
      now: () => "2026-08-09T00:00:00.000Z",
    });
    store.add(draft({ name: "good-one" }));
    // Hand-corrupt one entry (missing required fields) alongside the good one.
    const good = store.list()[0];
    writeFileSync(path, JSON.stringify({ projects: [good, { id: "bad", name: "" }] }));
    const listed = new FileProjectStore(path).list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("good-one");
  });
});

describe("deriveProjectDraft", () => {
  const discovery: DiscoveryResult = {
    path: "/code/orbital",
    kind: "workspace",
    primaryBranch: "main",
    repos: [
      { name: "atlas", path: "/code/orbital/atlas", branches: 3 },
      { name: "navcore", path: "/code/orbital/navcore", branches: 2 },
      { name: "atlas-docs", path: "/code/orbital/atlas-docs", branches: 2 },
    ],
  };

  it("sums the included branch counts and opens the first included repo", () => {
    const result = deriveProjectDraft(discovery, ["atlas", "navcore"], "main");
    expect(result.name).toBe("orbital");
    expect(result.repoCount).toBe(2);
    expect(result.branchCount).toBe(5);
    expect(result.openPath).toBe("/code/orbital/atlas");
    expect(result.primaryBranch).toBe("main");
  });

  it("persists ONLY the included repo paths (an excluded repo is absent)", () => {
    const result = deriveProjectDraft(discovery, ["atlas", "navcore"], "main");
    // "atlas-docs" was excluded → its path must not survive into the stored selection.
    expect(result.includedRepoPaths).toEqual(["/code/orbital/atlas", "/code/orbital/navcore"]);
  });

  it("opens the repo itself for a project-repo kind", () => {
    const repo: DiscoveryResult = {
      path: "/code/atlas",
      kind: "repo",
      primaryBranch: "trunk",
      repos: [{ name: "atlas", path: "/code/atlas", branches: 4 }],
    };
    const result = deriveProjectDraft(repo, ["atlas"], "trunk");
    expect(result.kind).toBe("repo");
    expect(result.openPath).toBe("/code/atlas");
    expect(result.branchCount).toBe(4);
  });
});
