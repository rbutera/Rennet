import type { ProcessedRepoSummary, Project, ProjectProcessEvent } from "@rennet/protocol";
import { describe, expect, it, vi } from "vitest";
import { deriveProgressView } from "./progress-feed-fold";

const repoProject: Project = {
  id: "p1",
  name: "orbital",
  path: "/orbital",
  kind: "repo",
  repoCount: 1,
  branchCount: 3,
  primaryBranch: "main",
  openPath: "/orbital",
  addedAt: "2026-08-11T00:00:00.000Z",
};

const workspace: Project = { ...repoProject, name: "ws", kind: "workspace", repoCount: 2 };

describe("deriveProgressView — the shared narration fold (issue #71)", () => {
  it("collapses a re-emitted stage into one trail row and upgrades it with the detail", () => {
    // A stage fires twice (start, then with a real detail) — the fold must keep ONE
    // trail row for it and carry the arrived detail, not stack two rows.
    const events: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
      { kind: "stage", repo: "orbital", stage: "tree", note: "Reading the file tree" },
      {
        kind: "stage",
        repo: "orbital",
        stage: "tree",
        note: "Reading the file tree",
        detail: "412 files",
      },
      { kind: "stage", repo: "orbital", stage: "build", note: "Building the repo map" },
    ];
    const view = deriveProgressView(events, [], repoProject);
    expect(view.repoBlocks).toHaveLength(1);
    const trail = view.repoBlocks[0]?.trail ?? [];
    // tree collapsed to one row (with detail) + build = two rows, not three.
    expect(trail).toHaveLength(2);
    expect(trail[0]).toEqual({ stage: "tree", note: "Reading the file tree", detail: "412 files" });
    expect(trail[1]).toEqual({ stage: "build", note: "Building the repo map", detail: undefined });
    // The headline is the latest real event's note + detail (never scripted).
    expect(view.headline).toBe("Building the repo map");
  });

  it("keeps a completed stage in the done-ledger while later stages arrive (current line last)", () => {
    const events: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
      {
        kind: "stage",
        repo: "orbital",
        stage: "resolve",
        note: "Finding the default branch",
        detail: "main",
      },
      { kind: "stage", repo: "orbital", stage: "symbols", note: "Extracting symbols" },
    ];
    const view = deriveProgressView(events, [], repoProject);
    const trail = view.repoBlocks[0]?.trail ?? [];
    // The earlier completed stage is still in the ledger; the latest is the current line.
    expect(trail.map((row) => row.stage)).toEqual(["resolve", "symbols"]);
    expect(view.headline).toBe("Extracting symbols");
  });

  it("degrades: no per-repo events, but the resolved summaries synthesise the done blocks", () => {
    const repos: ProcessedRepoSummary[] = [
      { repo: "atlas", path: "/ws/atlas", ok: true, files: 10, symbols: 4, references: 6 },
      { repo: "atlas-docs", path: "/ws/atlas-docs", ok: false, error: "not a git repository" },
    ];
    const view = deriveProgressView([], repos, workspace);
    expect(view.repoBlocks.map((block) => [block.repo, block.state])).toEqual([
      ["atlas", "done"],
      ["atlas-docs", "error"],
    ]);
    expect(view.doneSummary).toContain("1 could not be read");
    expect(view.repoBlocks[0]?.trail).toEqual([]);
  });

  it("tolerates unknown / not-repo-shaped kinds — skips them, never throws, repo trail intact", () => {
    // The capture/review milestones (#71) ride the SAME union but are not repo-shaped;
    // an older repo-only fold must skip them (and any future kind cast in) without
    // disturbing the repo blocks it does understand.
    const events: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
      { kind: "capture", note: "Captured the working tree", detail: "128 changed files" },
      { kind: "floor", note: "Built the deterministic floor" },
      { kind: "angle", title: "Security review", note: "admitted" },
      { kind: "review-done" },
      { kind: "review-error", message: "one angle timed out" },
      { kind: "stage", repo: "orbital", stage: "build", note: "Building the repo map" },
      // A kind this fold has never heard of — still skipped, never thrown on.
      { kind: "not-a-real-kind" } as unknown as ProjectProcessEvent,
    ];
    expect(() => deriveProgressView(events, [], repoProject)).not.toThrow();
    const view = deriveProgressView(events, [], repoProject);
    expect(view.repoBlocks).toHaveLength(1);
    expect((view.repoBlocks[0]?.trail ?? []).map((row) => row.stage)).toEqual(["build"]);
  });

  it("surfaces a landed artifact as an anchor on the done block; leaves an anchorless block inert", () => {
    // Anchoring (#71, task 6): a repo-done carrying an artifact ref makes the block an
    // anchor; without one the block has no anchor (honestly inert, never a dead link).
    const withAnchor: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
      {
        kind: "repo-done",
        repo: "orbital",
        summary: { repo: "orbital", path: "/orbital", ok: true, files: 1, symbols: 1 },
        artifact: { kind: "project", projectId: "p1" },
      },
    ];
    const anchored = deriveProgressView(withAnchor, [], repoProject);
    expect(anchored.repoBlocks[0]?.anchor).toEqual({ kind: "project", projectId: "p1" });

    const withoutAnchor: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
      {
        kind: "repo-done",
        repo: "orbital",
        summary: { repo: "orbital", path: "/orbital", ok: true, files: 1, symbols: 1 },
      },
    ];
    const inert = deriveProgressView(withoutAnchor, [], repoProject);
    expect(inert.repoBlocks[0]?.anchor).toBeUndefined();
  });

  it("is complete with ZERO model calls: the feed derives wholly from deterministic events (#71, task 7)", () => {
    // The fold is a pure function of the deterministic event stream and the resolved
    // per-repo summary — the model utility port is not an input, so a complete feed
    // cannot depend on model output. We spy on a stand-in model port and prove it is
    // never touched while the feed is fully derived.
    const modelPort = { generate: vi.fn() };
    const events: ProjectProcessEvent[] = [
      { kind: "repo-start", repo: "orbital", index: 1, total: 1 },
      {
        kind: "stage",
        repo: "orbital",
        stage: "resolve",
        note: "Finding the default branch",
        detail: "main",
      },
      {
        kind: "stage",
        repo: "orbital",
        stage: "tree",
        note: "Reading the file tree",
        detail: "412 files",
      },
      { kind: "stage", repo: "orbital", stage: "build", note: "Building the repo map" },
      {
        kind: "repo-done",
        repo: "orbital",
        summary: {
          repo: "orbital",
          path: "/orbital",
          ok: true,
          files: 412,
          symbols: 260,
          references: 900,
        },
      },
    ];
    const repos: ProcessedRepoSummary[] = [
      { repo: "orbital", path: "/orbital", ok: true, files: 412, symbols: 260, references: 900 },
    ];

    const view = deriveProgressView(events, repos, repoProject);

    // Every part of the feed is present: headline (latest real line), the full trail
    // with real details, the block outcome, and the terminal done summary with real
    // counts. Nothing is a placeholder.
    expect(view.headline).toBe("Building the repo map");
    expect((view.repoBlocks[0]?.trail ?? []).map((row) => row.note)).toEqual([
      "Finding the default branch",
      "Reading the file tree",
      "Building the repo map",
    ]);
    expect(view.repoBlocks[0]?.state).toBe("done");
    expect(view.doneSummary).toBe("412 files mapped, 260 symbols indexed");
    // And no model invocation was needed to produce any of it.
    expect(modelPort.generate).not.toHaveBeenCalled();
  });
});
